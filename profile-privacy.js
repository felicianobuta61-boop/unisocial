(() => {
  let pendingFollows = new Set();
  const privateProfiles = new Map();
  const signedMedia = new Map();
  const SIGNED_URL_TTL = 120;
  const SIGNED_URL_CACHE_MS = 100000;
  let privacyUserId = null;

  function pathFromStorageUrl(value, bucket) {
    if (!value) return null;
    try {
      const path = new URL(value, location.href).pathname;
      const markers = [
        `/storage/v1/object/public/${bucket}/`,
        `/storage/v1/object/sign/${bucket}/`,
        `/storage/v1/object/authenticated/${bucket}/`
      ];
      for (const marker of markers) {
        const at = path.indexOf(marker);
        if (at >= 0) return decodeURIComponent(path.slice(at + marker.length));
      }
      if (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('/')) {
        return decodeURIComponent(value.split(/[?#]/, 1)[0]);
      }
    } catch (error) {
      console.warn('URL de Storage inválida.');
    }
    return null;
  }

  async function signedStorageUrl(value, bucket) {
    const path = pathFromStorageUrl(value, bucket);
    if (!path || !sb) return value || null;
    const key = `${bucket}:${path}`;
    const cached = signedMedia.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) {
      console.warn(`Não foi possível assinar um ficheiro do bucket ${bucket}.`);
      return null;
    }
    signedMedia.set(key, { url: data.signedUrl, expiresAt: Date.now() + SIGNED_URL_CACHE_MS });
    return data.signedUrl;
  }

  async function signProfiles(rows) {
    return Promise.all((rows || []).map(async user => ({
      ...user,
      avatar_url: await signedStorageUrl(user.avatar_url, 'avatars')
    })));
  }

  function followLabel(uid, isPrivate) {
    if (FOLLOWING.has(uid)) return 'A seguir';
    if (pendingFollows.has(uid)) return 'Pedido enviado';
    return isPrivate ? 'Pedir para seguir' : 'Seguir';
  }

  function paintFollow(uid) {
    document.querySelectorAll('.fbtn[data-u]').forEach(button => {
      if (button.dataset.u !== uid) return;
      const isPrivate = button.dataset.private === 'true' ||
        privateProfiles.get(uid) === true;
      const following = FOLLOWING.has(uid);
      const pending = pendingFollows.has(uid);
      button.textContent = followLabel(uid, isPrivate);
      button.classList.toggle('on', following || pending);
      button.setAttribute('aria-pressed', String(following));
    });
    const count = document.getElementById('pfing');
    if (count) count.textContent = FOLLOWING.size;
  }

  function paintAllFollows() {
    document.querySelectorAll('.fbtn[data-u]').forEach(button => paintFollow(button.dataset.u));
  }

  window.loadFollows = async function loadFollows() {
    FOLLOWING = new Set();
    pendingFollows = new Set();
    if (!sb || !ME.id) return;
    const [follows, requests] = await Promise.all([
      sb.from('follows').select('following_id').eq('follower_id', ME.id),
      sb.from('follow_requests').select('following_id').eq('follower_id', ME.id)
    ]);
    if (follows.error) console.warn('Não foi possível carregar quem segues.');
    if (requests.error) console.warn('Não foi possível carregar pedidos pendentes.');
    FOLLOWING = new Set((follows.data || []).map(row => row.following_id));
    pendingFollows = new Set((requests.data || []).map(row => row.following_id));
    paintAllFollows();
  };

  window.paintFollow = function paintFollowState(uid) {
    paintFollow(uid);
  };

  window.toggleFollow = async function toggleFollow(uid) {
    if (!sb || !ME.id) return showToast('Entra na tua conta para seguir.');
    if (uid === ME.id) return;
    const buttons = [...document.querySelectorAll(`.fbtn[data-u="${uid}"]`)];
    buttons.forEach(button => { button.disabled = true; });
    try {
      if (FOLLOWING.has(uid)) {
        const { error } = await sb.from('follows').delete()
          .eq('follower_id', ME.id).eq('following_id', uid);
        if (error) throw error;
        FOLLOWING.delete(uid);
        showToast('Deixaste de seguir este perfil.');
      } else if (pendingFollows.has(uid)) {
        const { error } = await sb.rpc('cancel_follow_request', { target_profile_id: uid });
        if (error) throw error;
        pendingFollows.delete(uid);
        showToast('Pedido cancelado.');
      } else {
        const { data, error } = await sb.rpc('request_follow', { target_profile_id: uid });
        if (error) throw error;
        if (data === 'pending') {
          pendingFollows.add(uid);
          showToast('Pedido enviado; aguarda aprovação.');
        } else {
          FOLLOWING.add(uid);
          showToast('Agora estás a seguir este perfil.');
        }
      }
      paintFollow(uid);
      if (FEED === 'following') await loadFeed();
      await loadStories();
      if (typeof profCounts === 'function') await profCounts();
    } catch (error) {
      console.error('Não foi possível atualizar o seguimento:', error);
      showToast('Não foi possível atualizar o seguimento. Confirma se a migration RLS já foi aplicada.');
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  };

  window.loadPeople = async function loadPeople() {
    const box = document.getElementById('people');
    if (!box) return;
    if (!sb || !ME.id) {
      box.textContent = 'Entra na tua conta para ver pessoas.';
      return;
    }
    box.textContent = 'A carregar…';
    const { data, error } = await sb.rpc('search_profiles', {
      p_search_text: null,
      p_limit: 50
    });
    if (!box.isConnected) return;
    if (error) {
      console.error('Não foi possível pesquisar perfis:', error);
      box.textContent = 'Não foi possível carregar as pessoas. Confirma se a migration RLS já foi aplicada.';
      return;
    }
    if (!data?.length) {
      box.textContent = 'Ainda não há outras pessoas para mostrar.';
      return;
    }
    const profiles = await signProfiles(data);
    profiles.forEach(user => privateProfiles.set(user.id, !!user.is_private));
    box.className = 'widget';
    box.innerHTML = profiles.map(user => {
      const isPrivate = !!user.is_private;
      const following = FOLLOWING.has(user.id);
      const requested = pendingFollows.has(user.id);
      const label = followLabel(user.id, isPrivate);
      return `<div class="contact" data-u="${esc(user.id)}" data-online="${isOnline(user.id) ? 'true' : 'false'}">${presenceAvatar(user.id, user.full_name || '?', user.avatar_url, 'blue')}<div class="contact-info"><strong>${esc(user.full_name || 'Utilizador')}</strong><small>@${esc(user.username || '')}${isPrivate ? ' · Perfil privado' : ''}</small></div><button class="fbtn${following || requested ? ' on' : ''}" data-u="${esc(user.id)}" data-private="${isPrivate}" aria-pressed="${following}" onclick="toggleFollow('${esc(user.id)}')">${label}</button><button class="chip" style="margin-left:6px" aria-label="Enviar mensagem" onclick="chatWith('${esc(user.id)}')">✉</button></div>`;
    }).join('');
  };

  window.setPrivateProfile = async function setPrivateProfile(input) {
    const previous = !!ME.is_private;
    const next = !!input.checked;
    if (!sb || !ME.id) {
      input.checked = previous;
      return showToast('Entra na tua conta para alterar a privacidade.');
    }
    input.disabled = true;
    const { error } = await sb.from('profiles').update({ is_private: next }).eq('id', ME.id);
    input.disabled = false;
    if (error) {
      input.checked = previous;
      console.error('Não foi possível guardar a privacidade do perfil:', error);
      return showToast('Não foi possível guardar. Confirma se a migration RLS já foi aplicada.');
    }
    ME.is_private = next;
    showToast(next
      ? 'Perfil privado: só seguidores aprovados veem as tuas publicações e histórias.'
      : 'Perfil público: os pedidos pendentes foram aprovados.');
    await loadFollows();
    await loadFeed();
    await loadStories();
  };

  window.respondFollowRequest = async function respondFollowRequest(requesterId, approve) {
    const rpc = approve ? 'approve_follow_request' : 'decline_follow_request';
    const { error } = await sb.rpc(rpc, { requester_id: requesterId });
    if (error) {
      console.error('Não foi possível responder ao pedido:', error);
      showToast('Não foi possível responder ao pedido.');
      return;
    }
    await loadFollowRequests();
    await loadFollows();
    if (approve) {
      await loadFeed();
      await loadStories();
    }
    showToast(approve ? 'Pedido aprovado.' : 'Pedido recusado.');
  };

  window.loadFollowRequests = async function loadFollowRequests() {
    const box = document.getElementById('follow-requests-list');
    if (!box) return;
    if (!sb || !ME.id) {
      box.innerHTML = '<p class="small">Entra na tua conta para ver pedidos.</p>';
      return;
    }
    box.innerHTML = '<p class="small">A carregar pedidos…</p>';
    const { data, error } = await sb.rpc('list_follow_requests');
    if (!box.isConnected) return;
    if (error) {
      console.warn('Não foi possível carregar pedidos:', error);
      box.innerHTML = '<p class="small">Os pedidos ficam disponíveis depois de aplicar a migration RLS.</p>';
      return;
    }
    if (!data?.length) {
      box.innerHTML = '<p class="small">Não tens pedidos pendentes.</p>';
      return;
    }
    box.innerHTML = data.map(request => `<div class="contact"><div class="contact-info"><strong>${esc(request.full_name || 'Utilizador')}</strong><small>@${esc(request.username || '')} · ${ago(request.created_at)}</small></div><button class="fbtn" onclick="respondFollowRequest('${esc(request.requester_id)}',true)">Aceitar</button><button class="chip" onclick="respondFollowRequest('${esc(request.requester_id)}',false)">Recusar</button></div>`).join('');
  };

  function mountPrivacySettings() {
    const heading = [...document.querySelectorAll('#pg h2')]
      .find(node => node.textContent.trim().toLowerCase().includes('privacidade'));
    const widget = heading?.nextElementSibling;
    if (!widget || widget.dataset.privacyMounted === 'true') return;
    widget.dataset.privacyMounted = 'true';
    const rows = [...widget.querySelectorAll('label.row')];
    if (rows[1]) rows[1].remove();
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML = '<span>Perfil privado</span><input id="privateProfileToggle" type="checkbox">';
    const input = row.querySelector('input');
    input.checked = !!ME.is_private;
    input.disabled = !ME.id;
    input.addEventListener('change', () => setPrivateProfile(input));
    widget.append(row);
    const note = document.createElement('p');
    note.className = 'small';
    note.textContent = 'Quando ativado, só seguidores aprovados veem publicações e histórias.';
    widget.append(note);
    const requests = document.createElement('div');
    requests.className = 'widget';
    requests.innerHTML = '<h3 class="widget-title">Pedidos para seguir</h3><div id="follow-requests-list"><p class="small">A carregar…</p></div>';
    widget.insertAdjacentElement('afterend', requests);
    loadFollowRequests();
  }

  const originalGo = window.go;
  if (originalGo) {
    window.go = function goWithPrivacySettings(tab, ...args) {
      const result = originalGo(tab, ...args);
      if (tab === 'Definições') setTimeout(mountPrivacySettings, 0);
      return result;
    };
  }

  const originalPostEl = window.postEl;
  if (originalPostEl) {
    window.postEl = function postWithFollowState(post) {
      const element = originalPostEl(post);
      const button = element.querySelector('.fbtn[data-u]');
      if (button) {
        const isPrivate = !!post.author?.is_private;
        privateProfiles.set(post.author_id, isPrivate);
        button.dataset.private = String(isPrivate);
        paintFollow(post.author_id);
      }
      return element;
    };
  }

  const originalHydrate = window.hydrate;
  if (originalHydrate) {
    window.hydrate = async function hydrateWithPrivateMedia(posts) {
      const hydrated = await originalHydrate(posts);
      const ids = [...new Set((posts || []).map(post => post.author_id).filter(Boolean))];
      let flags = [];
      if (ids.length) {
        const { data, error } = await sb.from('profiles').select('id,is_private').in('id', ids);
        if (error) console.warn('Não foi possível carregar o estado privado dos perfis.');
        flags = data || [];
      }
      const privateById = new Map(flags.map(row => [row.id, !!row.is_private]));
      return Promise.all(hydrated.map(async post => {
        const author = post.author || {};
        const isPrivate = privateById.get(post.author_id) || false;
        privateProfiles.set(post.author_id, isPrivate);
        return {
          ...post,
          media_url: await signedStorageUrl(post.media_url, 'post-media'),
          author: {
            ...author,
            is_private: isPrivate,
            avatar_url: await signedStorageUrl(author.avatar_url, 'avatars')
          }
        };
      }));
    };
  }

  const originalLoadStories = window.loadStories;
  if (originalLoadStories) {
    window.loadStories = async function loadStoriesWithPrivateMedia() {
      await originalLoadStories();
      for (const group of STORIES.values()) {
        group.u.avatar_url = await signedStorageUrl(group.u.avatar_url, 'avatars');
        await Promise.all(group.items.map(async story => {
          story.image_url = await signedStorageUrl(story.image_url, 'stories');
        }));
      }
      renderStories();
    };
  }

  const originalLoadChats = window.loadChats;
  if (originalLoadChats) {
    window.loadChats = async function loadChatsWithPrivateAvatars(first) {
      await originalLoadChats(first);
      await Promise.all([...CHAT.people.values()].map(async user => {
        user.avatar_url = await signedStorageUrl(user.avatar_url, 'avatars');
      }));
      document.querySelectorAll('#clist .contact[data-u]').forEach(row => {
        const user = CHAT.people.get(row.dataset.u);
        const avatar = row.querySelector('.avatar');
        if (user && avatar) setAv(avatar, user.avatar_url, ini(user.full_name || '?'));
      });
      if (CHAT.uid) {
        const user = CHAT.people.get(CHAT.uid);
        const avatar = document.querySelector('#chead .avatar');
        if (user && avatar) setAv(avatar, user.avatar_url, ini(user.full_name || '?'));
      }
    };
  }

  const originalSetAv = window.setAv;
  if (originalSetAv) {
    window.setAv = function setAvWithPrivateStorage(element, value, initials) {
      if (!pathFromStorageUrl(value, 'avatars')) return originalSetAv(element, value, initials);
      signedStorageUrl(value, 'avatars')
        .then(url => originalSetAv(element, url, initials))
        .catch(() => originalSetAv(element, null, initials));
    };
  }

  const originalUploadAvatar = window.uploadAvatar;
  if (originalUploadAvatar) {
    window.uploadAvatar = async function uploadPrivateAvatar(input) {
      await originalUploadAvatar(input);
      ME.avatar_url = await signedStorageUrl(ME.avatar_url, 'avatars');
      if (typeof applyUser === 'function') applyUser();
    };
  }

  const originalOnSession = window.onSession;
  if (originalOnSession) {
    window.onSession = async function loadPrivateProfileState(session) {
      await originalOnSession(session);
      if (!session) {
        ME.is_private = false;
        pendingFollows = new Set();
        privacyUserId = null;
        privateProfiles.clear();
        signedMedia.clear();
        return;
      }
      if (privacyUserId && privacyUserId !== session.user.id) {
        privateProfiles.clear();
        signedMedia.clear();
        pendingFollows = new Set();
      }
      privacyUserId = session.user.id;
      const { data, error } = await sb.from('profiles')
        .select('is_private,avatar_url').eq('id', session.user.id).maybeSingle();
      if (error) {
        console.warn('Não foi possível carregar a privacidade do perfil.');
        ME.is_private = false;
        return;
      }
      ME.is_private = !!data?.is_private;
      ME.avatar_url = await signedStorageUrl(data?.avatar_url, 'avatars');
      if (typeof applyUser === 'function') applyUser();
      const input = document.getElementById('privateProfileToggle');
      if (input) input.checked = ME.is_private;
    };
  }
})();
