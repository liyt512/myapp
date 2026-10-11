(function () {
  'use strict';

  const TOKEN_KEY = 'liubai.session.v1';
  const SERVER_KEY = 'liubai.server.v1';
  const embeddedServer = new URLSearchParams(window.location.search).get('server') || '';
  let apiBase = localStorage.getItem(SERVER_KEY) || embeddedServer;
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let me = null;
  let friendState = { friends: [], incoming: [], outgoing: [] };
  let friendTab = 'recommend';
  let pendingDeleteId = null;
  let selectedAudioUrl = '';
  let authMode = 'register';
  let hubLoadId = 0;

  const toastNode = document.getElementById('toast');
  let toastTimer;
  function toast(message) {
    toastNode.textContent = message;
    toastNode.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastNode.classList.remove('show'); }, 2300);
  }

  function normalizeServer(value) {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
      throw new Error('服务器地址需要使用 HTTPS。');
    }
    return url.origin;
  }

  async function request(path, options) {
    if (!apiBase) throw new Error('请先填写服务器地址。');
    const config = Object.assign({ method: 'GET' }, options || {});
    config.headers = Object.assign({}, config.headers || {});
    if (token) config.headers.Authorization = 'Bearer ' + token;
    if (config.body && !(config.body instanceof FormData) && typeof config.body !== 'string') {
      config.body = JSON.stringify(config.body);
      config.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(apiBase + path, config);
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(body.error || '连接失败，请稍后再试。');
    return body;
  }

  function avatarMark(label) {
    const node = document.createElement('div');
    node.className = 'avatar avatar-mark';
    node.setAttribute('aria-label', label || '留白好友');
    node.textContent = '>_<';
    return node;
  }

  function replaceSampleAvatars() {
    document.querySelectorAll('img.avatar').forEach(function (image) {
      image.replaceWith(avatarMark('留白账号'));
    });
    document.querySelectorAll('.post').forEach(function (post) { post.remove(); });
  }

  function installStyle() {
    const style = document.createElement('style');
    style.textContent = [
      '.avatar-mark{display:grid;place-items:center;flex:none;background:#171717;color:#fff;font-size:10px;font-weight:700;letter-spacing:-1px;border:1px solid #171717}',
      '.auth-backdrop,.account-backdrop{position:fixed;inset:0;background:#0009;z-index:100;display:none;align-items:center;justify-content:center;padding:20px}',
      '.auth-backdrop.open,.account-backdrop.open{display:flex}',
      '.auth-card,.account-card{background:#f6f6f4;border:1px solid #171717;border-radius:24px;width:min(430px,100%);padding:25px;box-shadow:0 24px 90px #0004}',
      '.auth-card h2,.account-card h2{font-size:22px;margin:5px 0 8px;letter-spacing:-.7px}',
      '.auth-card p,.account-card p{color:#71716b;font-size:12px;line-height:1.7;margin:0 0 17px}',
      '.auth-card label{display:block;font-size:11px;color:#666;margin:12px 0 6px}',
      '.auth-card input{width:100%;padding:12px 13px;border:1px solid #deded8;border-radius:13px;background:#fff;outline:none;font-size:13px}',
      '.auth-card input:focus{border-color:#171717}',
      '.auth-actions{display:flex;gap:9px;margin-top:17px}',
      '.auth-actions button,.account-actions button{flex:1;border:1px solid #171717;background:#171717;color:#fff;border-radius:18px;padding:11px 14px;font-size:12px}',
      '.auth-actions button.secondary,.account-actions button.secondary{background:#fff;color:#171717;border-color:#deded8}',
      '.auth-error{min-height:18px;color:#a12a2a!important;margin:9px 0 0!important}',
      '.auth-switch{display:block;margin:13px auto 0;border:0;background:none;color:#555;text-decoration:underline;font-size:12px}',
      '.account-actions{display:flex;gap:9px;margin-top:17px}',
      '.friend-empty{padding:24px 8px;text-align:center;color:#777;font-size:12px}',
      '.friend-empty span{font-size:19px;color:#171717}',
      '.friend-empty p{line-height:1.8}',
      '.friend-card-actions{display:flex;gap:7px;margin-left:auto}',
      '.friend-card-actions .follow{margin-left:0}',
      '.friend-state{font-size:10px;color:#777;margin-left:auto;white-space:nowrap}',
      '.comment-author{font-weight:600;color:#171717;margin-right:5px}',
      '.feed-empty{background:#fff;border:1px solid var(--line);border-radius:20px;text-align:center;color:#777;padding:42px 20px;font-size:13px;line-height:1.9}',
      '.feed-empty b{display:block;font-size:22px;color:#171717;margin-bottom:8px}',
      '.post-media{max-height:480px}',
      '.top-right .account-button{border:1px solid #171717;border-radius:50%;width:35px;height:35px;background:#171717;color:white;font-size:10px;font-weight:700;letter-spacing:-1px}',
      '@media(max-width:700px){.auth-card,.account-card{padding:21px}.composer-tools{margin-left:0;justify-content:space-between}.post{padding:17px 15px}.post-foot{gap:14px}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function installAuthDialog() {
    const layer = document.createElement('div');
    layer.className = 'auth-backdrop';
    layer.id = 'authDialog';
    layer.innerHTML = '<section class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">' +
      '<div class="eyebrow">&gt;,&lt;　留白账号</div><h2 id="authTitle">注册一个账号</h2>' +
      '<p>账号和日常保存在服务器上。把账号名告诉朋友，他们就能搜索并添加你。</p>' +
      '<label for="serverAddress">服务器地址</label><input id="serverAddress" type="url" inputmode="url" placeholder="https://服务器IP" autocomplete="url">' +
      '<label for="authUsername">账号名</label><input id="authUsername" maxlength="24" autocomplete="username" placeholder="3–24 位字母、数字或下划线">' +
      '<div id="nicknameField"><label for="authNickname">昵称</label><input id="authNickname" maxlength="24" autocomplete="nickname" placeholder="朋友看到的名字"></div>' +
      '<label for="authPassword">密码</label><input id="authPassword" type="password" maxlength="128" autocomplete="new-password" placeholder="至少 8 位">' +
      '<p class="auth-error" id="authError" aria-live="polite"></p>' +
      '<div class="auth-actions"><button id="authSubmit" type="button">创建账号</button></div>' +
      '<button class="auth-switch" id="authSwitch" type="button">已有账号？登录</button></section>';
    document.body.appendChild(layer);
    document.getElementById('serverAddress').value = apiBase;
    document.getElementById('authSubmit').addEventListener('click', submitAuth);
    document.getElementById('authSwitch').addEventListener('click', function () {
      setAuthMode(authMode === 'register' ? 'login' : 'register');
    });
    document.getElementById('authPassword').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') submitAuth();
    });
  }

  function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === 'register';
    document.getElementById('authTitle').textContent = registering ? '注册一个账号' : '登录留白';
    document.getElementById('nicknameField').hidden = !registering;
    document.getElementById('authPassword').autocomplete = registering ? 'new-password' : 'current-password';
    document.getElementById('authSubmit').textContent = registering ? '创建账号' : '登录';
    document.getElementById('authSwitch').textContent = registering ? '已有账号？登录' : '第一次来？创建账号';
    document.getElementById('authError').textContent = '';
  }

  function showAuth(message) {
    document.getElementById('authDialog').classList.add('open');
    if (message) document.getElementById('authError').textContent = message;
  }

  async function submitAuth() {
    const button = document.getElementById('authSubmit');
    const errorNode = document.getElementById('authError');
    button.disabled = true;
    errorNode.textContent = '';
    try {
      apiBase = normalizeServer(document.getElementById('serverAddress').value);
      const health = await fetch(apiBase + '/api/health');
      if (!health.ok) throw new Error('暂时连不上服务器，请检查地址和网络。');
      localStorage.setItem(SERVER_KEY, apiBase);
      const username = document.getElementById('authUsername').value.trim().toLowerCase();
      const password = document.getElementById('authPassword').value;
      const body = { username: username, password: password };
      let result;
      if (authMode === 'register') {
        body.displayName = document.getElementById('authNickname').value.trim();
        result = await request('/api/register', { method: 'POST', body: body });
      } else {
        result = await request('/api/login', { method: 'POST', body: body });
      }
      token = result.token;
      localStorage.setItem(TOKEN_KEY, token);
      me = result.user;
      document.getElementById('authDialog').classList.remove('open');
      document.getElementById('authPassword').value = '';
      await loadApp();
      toast(authMode === 'register' ? '账号创建好了，记得把账号名告诉朋友' : '登录成功');
    } catch (error) {
      errorNode.textContent = error.message || '操作失败，请稍后再试。';
    } finally {
      button.disabled = false;
    }
  }

  function installAccountButton() {
    const host = document.querySelector('.top-right');
    const button = document.createElement('button');
    button.className = 'account-button';
    button.type = 'button';
    button.id = 'accountButton';
    button.textContent = '>_<';
    button.setAttribute('aria-label', '我的账号');
    host.appendChild(button);
    button.addEventListener('click', openAccount);

    const layer = document.createElement('div');
    layer.className = 'account-backdrop';
    layer.id = 'accountDialog';
    layer.innerHTML = '<section class="account-card" role="dialog" aria-modal="true"><div class="eyebrow">MY LITTLE SPACE</div>' +
      '<h2 id="accountName">我的账号</h2><p id="accountInfo"></p>' +
      '<div class="account-actions"><button class="secondary" id="accountClose">返回</button><button id="logoutButton">退出账号</button></div></section>';
    layer.addEventListener('click', function (event) { if (event.target === layer) layer.classList.remove('open'); });
    document.body.appendChild(layer);
    document.getElementById('accountClose').addEventListener('click', function () { layer.classList.remove('open'); });
    document.getElementById('logoutButton').addEventListener('click', logout);
  }

  function openAccount() {
    if (!me) return showAuth();
    document.getElementById('accountName').textContent = me.displayName || '留白用户';
    document.getElementById('accountInfo').textContent = '账号名 @' + me.username + '。把账号名告诉朋友，他们可以在好友页面搜索你。';
    document.getElementById('accountDialog').classList.add('open');
  }

  function logout() {
    token = '';
    me = null;
    friendState = { friends: [], incoming: [], outgoing: [] };
    localStorage.removeItem(TOKEN_KEY);
    document.getElementById('accountDialog').classList.remove('open');
    renderEmptyFeed('登录后查看好友的日常');
    renderProfile();
    showAuth('已退出账号。');
  }

  function renderProfile() {
    const name = document.querySelector('.me-name');
    const handle = document.querySelector('.me-handle');
    if (name) name.textContent = me ? me.displayName : '还没有登录';
    if (handle) handle.textContent = me ? '@' + me.username + ' · 留白好友圈' : '登录后开始分享日常';
    const friendCount = document.getElementById('friendCount');
    if (friendCount) friendCount.textContent = friendState.friends.length;
    const counts = document.querySelectorAll('.me-card .stat b');
    if (counts.length > 0) counts[0].textContent = me && me.postCount !== undefined ? me.postCount : '0';
    if (counts.length > 2) counts[2].textContent = me && me.likeCount !== undefined ? me.likeCount : '0';
    const accountButton = document.getElementById('accountButton');
    if (accountButton) accountButton.textContent = me ? '>_<' : 'o_o';
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date);
  }

  function mediaUrl(value) {
    return value ? apiBase + value : '';
  }

  function renderEmptyFeed(message) {
    const host = document.getElementById('posts');
    host.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'feed-empty';
    const icon = document.createElement('b');
    icon.textContent = '>_<';
    const copy = document.createElement('span');
    copy.textContent = message;
    empty.append(icon, copy);
    host.appendChild(empty);
  }

  function makeAction(label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className || 'reaction';
    button.textContent = label;
    return button;
  }

  function makePost(post) {
    const article = document.createElement('article');
    article.className = 'post';
    article.dataset.postId = String(post.id);
    article.dataset.owned = post.owned ? 'true' : 'false';

    const header = document.createElement('div');
    header.className = 'post-head';
    header.appendChild(avatarMark(post.displayName));
    const who = document.createElement('div');
    const author = document.createElement('div');
    author.className = 'post-author';
    author.textContent = post.displayName;
    const time = document.createElement('div');
    time.className = 'post-time';
    time.textContent = formatTime(post.createdAt) + ' · @' + post.username;
    who.append(author, time);
    header.appendChild(who);
    if (post.owned) {
      const more = makeAction('···', 'more');
      more.setAttribute('aria-label', '删除选项');
      more.addEventListener('click', function () { openDeleteDialog(article); });
      header.appendChild(more);
    }
    article.appendChild(header);

    if (post.text) {
      const copy = document.createElement('p');
      copy.className = 'post-copy';
      copy.textContent = post.text;
      article.appendChild(copy);
    }
    if (post.music) {
      const music = document.createElement('div');
      music.className = 'music-chip';
      music.textContent = '♪_♪ ' + post.music;
      article.appendChild(music);
    }
    if (post.mediaUrl) {
      let media;
      if (String(post.mediaType || '').startsWith('video/')) {
        media = document.createElement('video');
        media.controls = true;
        media.playsInline = true;
        media.preload = 'metadata';
      } else {
        media = document.createElement('img');
        media.alt = '日常照片';
      }
      media.className = 'post-media';
      media.src = mediaUrl(post.mediaUrl);
      article.appendChild(media);
    }
    if (post.audioUrl) {
      const audio = document.createElement('audio');
      audio.className = 'post-audio';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = mediaUrl(post.audioUrl);
      article.appendChild(audio);
    }

    const footer = document.createElement('div');
    footer.className = 'post-foot';
    const like = makeAction((post.liked ? '♥ ' : '♡ ') + post.likeCount, 'reaction like' + (post.liked ? ' liked' : ''));
    like.addEventListener('click', async function () {
      try {
        const result = await request('/api/posts/' + post.id + '/like', { method: post.liked ? 'DELETE' : 'POST' });
        post.liked = result.liked;
        post.likeCount += post.liked ? 1 : -1;
        like.textContent = (post.liked ? '♥ ' : '♡ ') + post.likeCount;
        like.classList.toggle('liked', post.liked);
      } catch (error) { toast(error.message); }
    });
    const commentButton = makeAction('评论', 'reaction comment-toggle');
    const shareButton = makeAction('分享', 'reaction share');
    shareButton.addEventListener('click', function () { toast('让朋友搜索 @' + post.username + '，即可添加好友'); });
    footer.append(like, commentButton, shareButton);
    article.appendChild(footer);

    const comments = document.createElement('div');
    comments.className = 'comments';
    const list = document.createElement('div');
    list.className = 'comment-list';
    const input = document.createElement('input');
    input.className = 'comment-input';
    input.maxLength = 500;
    input.placeholder = '写下你的评论…';
    comments.append(list, input);
    article.appendChild(comments);

    let commentsLoaded = false;
    commentButton.addEventListener('click', async function () {
      comments.classList.toggle('open');
      if (!comments.classList.contains('open') || commentsLoaded) return;
      try {
        const result = await request('/api/posts/' + post.id + '/comments');
        result.comments.forEach(function (item) { list.appendChild(makeComment(item)); });
        commentsLoaded = true;
      } catch (error) { toast(error.message); }
    });
    input.addEventListener('keydown', async function (event) {
      if (event.key !== 'Enter' || !input.value.trim()) return;
      event.preventDefault();
      const value = input.value.trim();
      input.disabled = true;
      try {
        await request('/api/posts/' + post.id + '/comments', { method: 'POST', body: { text: value } });
        list.appendChild(makeComment({ displayName: me.displayName, username: me.username, text: value }));
        input.value = '';
        commentsLoaded = true;
      } catch (error) { toast(error.message); }
      finally { input.disabled = false; }
    });
    return article;
  }

  function makeComment(comment) {
    const row = document.createElement('div');
    row.className = 'comment-row';
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = comment.displayName + '：';
    const text = document.createElement('span');
    text.textContent = comment.text;
    row.append(author, text);
    return row;
  }

  async function loadFeed() {
    const result = await request('/api/posts');
    const host = document.getElementById('posts');
    host.replaceChildren();
    if (!result.posts.length) return renderEmptyFeed('发布第一条日常，或者先添加好友吧');
    result.posts.forEach(function (post) { host.appendChild(makePost(post)); });
  }

  async function refreshFriendState() {
    friendState = await request('/api/friends');
    renderProfile();
  }

  async function loadApp() {
    me = await request('/api/me');
    await refreshFriendState();
    renderProfile();
    await loadFeed();
    renderSideFriends();
  }

  function personCard(person, subtitle) {
    const row = document.createElement('div');
    row.className = 'friend hub-friend';
    row.appendChild(avatarMark(person.displayName));
    const copy = document.createElement('div');
    copy.className = 'friend-copy';
    const name = document.createElement('div');
    name.className = 'friend-name';
    name.textContent = person.displayName;
    const sub = document.createElement('div');
    sub.className = 'friend-sub';
    sub.textContent = subtitle || '@' + person.username;
    copy.append(name, sub);
    row.appendChild(copy);
    return row;
  }

  async function sendFriendRequest(userId) {
    const result = await request('/api/friend-requests', { method: 'POST', body: { userId: Number(userId) } });
    await refreshFriendState();
    await renderFriendHub();
    renderSideFriends();
    if (result.accepted) {
      await loadFeed();
      toast('你们已经成为好友啦');
    } else if (result.alreadyPending) toast('好友申请已发送');
    else toast('好友申请已发送');
  }

  async function acceptFriendRequest(requestId) {
    await request('/api/friend-requests/' + requestId + '/accept', { method: 'POST' });
    await refreshFriendState();
    await renderFriendHub();
    renderSideFriends();
    await loadFeed();
    toast('好友添加成功');
  }

  async function removeFriendRequest(requestId) {
    await request('/api/friend-requests/' + requestId, { method: 'DELETE' });
    await refreshFriendState();
    await renderFriendHub();
    renderSideFriends();
    toast('申请已处理');
  }

  function addFriend(id) { sendFriendRequest(id).catch(function (error) { toast(error.message); }); }
  function setFriendTab(tab) {
    friendTab = tab;
    document.getElementById('friendSearch').value = '';
    renderFriendHub();
  }

  function openFriendHub(tab) {
    if (!me) return showAuth();
    friendTab = tab || 'recommend';
    document.getElementById('friendSearch').value = '';
    document.getElementById('friendHub').classList.add('open');
    renderFriendHub();
  }
  function closeFriendHub() { document.getElementById('friendHub').classList.remove('open'); }

  async function renderFriendHub() {
    const thisLoad = ++hubLoadId;
    const host = document.getElementById('friendHubList');
    host.replaceChildren();
    document.querySelectorAll('.friend-tabs button').forEach(function (button) {
      button.classList.toggle('active', button.dataset.tab === friendTab);
    });
    const query = document.getElementById('friendSearch').value.trim();
    try {
      await refreshFriendState();
      let rows = [];
      if (friendTab === 'recommend') {
        if (query.length >= 2) {
          const result = await request('/api/users?q=' + encodeURIComponent(query));
          const ids = new Set(friendState.friends.map(function (item) { return item.id; }));
          const outgoing = new Set(friendState.outgoing.map(function (item) { return item.user.id; }));
          const incoming = new Set(friendState.incoming.map(function (item) { return item.user.id; }));
          rows = result.users.filter(function (person) { return !ids.has(person.id) && !outgoing.has(person.id) && !incoming.has(person.id); })
            .map(function (person) { return { type: 'user', user: person }; });
        }
      } else if (friendTab === 'friends') {
        rows = friendState.friends.filter(function (person) {
          return !query || (person.displayName + ' ' + person.username).toLowerCase().includes(query.toLowerCase());
        }).map(function (person) { return { type: 'friend', user: person }; });
      } else {
        rows = friendState.incoming.map(function (item) { return { type: 'incoming', user: item.user, requestId: item.requestId }; })
          .concat(friendState.outgoing.map(function (item) { return { type: 'outgoing', user: item.user, requestId: item.requestId }; }))
          .filter(function (item) { return !query || (item.user.displayName + ' ' + item.user.username).toLowerCase().includes(query.toLowerCase()); });
      }
      if (thisLoad !== hubLoadId) return;
      rows.forEach(function (item) {
        const row = personCard(item.user, '@' + item.user.username + (item.type === 'incoming' ? ' · 等待你处理' : ''));
        const actions = document.createElement('div');
        actions.className = 'friend-card-actions';
        if (item.type === 'user') {
          const add = makeAction('添加好友', 'follow');
          add.addEventListener('click', function () { addFriend(item.user.id); });
          actions.appendChild(add);
        } else if (item.type === 'friend') {
          const tag = document.createElement('span');
          tag.className = 'friend-state';
          tag.textContent = '已添加';
          actions.appendChild(tag);
        } else if (item.type === 'incoming') {
          const accept = makeAction('接受', 'follow following');
          accept.addEventListener('click', function () { acceptFriendRequest(item.requestId).catch(function (error) { toast(error.message); }); });
          const decline = makeAction('忽略', 'follow');
          decline.addEventListener('click', function () { removeFriendRequest(item.requestId).catch(function (error) { toast(error.message); }); });
          actions.append(accept, decline);
        } else {
          const cancel = makeAction('撤回申请', 'follow');
          cancel.addEventListener('click', function () { removeFriendRequest(item.requestId).catch(function (error) { toast(error.message); }); });
          actions.appendChild(cancel);
        }
        row.appendChild(actions);
        host.appendChild(row);
      });
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'friend-empty';
        const face = document.createElement('span');
        face.textContent = '>_<';
        const copy = document.createElement('p');
        if (friendTab === 'recommend') copy.textContent = query.length < 2 ? '输入朋友的账号名或昵称，至少 2 个字即可搜索。' : '没有找到账号。请确认朋友把留白账号名告诉你。';
        else if (friendTab === 'friends') copy.textContent = '好友会显示在这里。去“推荐”里搜索朋友的账号名吧。';
        else copy.textContent = '还没有待处理的好友申请。';
        empty.append(face, copy);
        host.appendChild(empty);
      }
    } catch (error) {
      if (thisLoad === hubLoadId) {
        const empty = document.createElement('div');
        empty.className = 'friend-empty';
        empty.textContent = error.message;
        host.appendChild(empty);
      }
    }
  }

  async function renderSideFriends() {
    const host = document.getElementById('sideFriendList');
    if (!host) return;
    host.replaceChildren();
    if (!me) {
      const copy = document.createElement('div');
      copy.className = 'friend-empty';
      copy.textContent = '登录后搜索并添加好友';
      host.appendChild(copy);
      return;
    }
    try {
      const result = await request('/api/friends');
      friendState = result;
      renderProfile();
      if (!result.friends.length) {
        const copy = document.createElement('div');
        copy.className = 'friend-empty';
        copy.textContent = '把你的账号名告诉朋友，或去好友页搜索他们。';
        host.appendChild(copy);
        return;
      }
      result.friends.slice(0, 4).forEach(function (person) {
        const row = personCard(person, '@' + person.username);
        const status = document.createElement('span');
        status.className = 'friend-state';
        status.textContent = '好友';
        row.appendChild(status);
        host.appendChild(row);
      });
    } catch (error) { toast(error.message); }
  }

  function openComposer(kind) {
    if (!me) return showAuth();
    document.getElementById('modal').classList.add('open');
    if (kind === 'photo') document.getElementById('photoInput').click();
    if (kind === 'video') document.getElementById('videoInput').click();
    if (kind === 'music') document.getElementById('audioInput').click();
  }
  function closeComposer() { document.getElementById('modal').classList.remove('open'); }

  function loadMedia(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { toast('照片或视频不能超过 50 MB'); input.value = ''; return; }
    const preview = document.getElementById('preview');
    preview.querySelectorAll('img,video').forEach(function (old) {
      if (old.src && old.src.startsWith('blob:')) URL.revokeObjectURL(old.src);
    });
    preview.style.display = 'block';
    preview.replaceChildren();
    let element;
    if (file.type.startsWith('video/')) { element = document.createElement('video'); element.controls = true; }
    else { element = document.createElement('img'); element.alt = '上传预览'; }
    element.src = URL.createObjectURL(file);
    preview.appendChild(element);
  }

  function loadAudio(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast('配乐文件不能超过 20 MB'); input.value = ''; return; }
    if (selectedAudioUrl) URL.revokeObjectURL(selectedAudioUrl);
    selectedAudioUrl = URL.createObjectURL(file);
    const preview = document.getElementById('audioPreview');
    preview.hidden = false;
    preview.replaceChildren();
    const name = document.createElement('span');
    name.textContent = '已选配乐：' + file.name;
    const player = document.createElement('audio');
    player.controls = true;
    player.preload = 'metadata';
    player.src = selectedAudioUrl;
    preview.append(name, player);
  }

  async function publishPost() {
    if (!me) return showAuth();
    const caption = document.getElementById('caption');
    const music = document.getElementById('music');
    const mediaInput = document.getElementById('photoInput').files?.[0] || document.getElementById('videoInput').files?.[0];
    const audioFile = document.getElementById('audioInput').files?.[0];
    if (!caption.value.trim() && !mediaInput && !audioFile && !music.value) { toast('写点文字或添加照片、视频、配乐吧'); return; }
    const form = new FormData();
    form.append('text', caption.value.trim());
    form.append('music', music.value || '');
    if (mediaInput) form.append('media', mediaInput, mediaInput.name);
    if (audioFile) form.append('audio', audioFile, audioFile.name);
    const button = document.querySelector('#modal .publish');
    button.disabled = true;
    button.textContent = '正在发布…';
    try {
      await request('/api/posts', { method: 'POST', body: form });
      caption.value = '';
      document.getElementById('preview').replaceChildren();
      document.getElementById('preview').style.display = 'none';
      document.getElementById('photoInput').value = '';
      document.getElementById('videoInput').value = '';
      document.getElementById('audioInput').value = '';
      document.getElementById('audioPreview').replaceChildren();
      document.getElementById('audioPreview').hidden = true;
      music.selectedIndex = 0;
      if (selectedAudioUrl) URL.revokeObjectURL(selectedAudioUrl);
      selectedAudioUrl = '';
      closeComposer();
      await loadApp();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('日常已发布，好友现在能看到了');
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; button.textContent = '发布日常'; }
  }

  function openDeleteDialog(post) {
    pendingDeleteId = post.dataset.postId;
    document.querySelector('#deleteModal .confirm-modal p').textContent = '删除后，所有设备上的好友动态都会移除这条日常。';
    document.getElementById('deleteModal').classList.add('open');
  }
  function closeDeleteDialog() {
    pendingDeleteId = null;
    document.getElementById('deleteModal').classList.remove('open');
  }
  async function confirmDeletePost() {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    try {
      await request('/api/posts/' + id, { method: 'DELETE' });
      const post = document.querySelector('[data-post-id="' + CSS.escape(id) + '"]');
      if (post) post.remove();
      closeDeleteDialog();
      await loadFeed();
      await loadProfileCounts();
      toast('日常已从所有设备删除');
    } catch (error) { toast(error.message); }
  }

  async function loadProfileCounts() {
    if (!me) return;
    me = await request('/api/me');
    renderProfile();
  }

  async function start() {
    installStyle();
    replaceSampleAvatars();
    installAuthDialog();
    installAccountButton();
    const date = document.getElementById('today');
    if (date) date.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
    document.getElementById('photoInput').addEventListener('change', function (event) { loadMedia(event.target); });
    document.getElementById('videoInput').addEventListener('change', function (event) { loadMedia(event.target); });
    document.getElementById('audioInput').addEventListener('change', function (event) { loadAudio(event.target); });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeComposer(); closeFriendHub(); closeDeleteDialog(); }
    });
    const sideTitle = document.querySelector('#friends .side-title');
    if (sideTitle && sideTitle.firstChild) sideTitle.firstChild.textContent = '我的好友 ';
    renderProfile();
    if (!token) {
      renderEmptyFeed('登录后查看好友的日常');
      showAuth();
      return;
    }
    try {
      await loadApp();
    } catch (error) {
      token = '';
      localStorage.removeItem(TOKEN_KEY);
      renderEmptyFeed('连接服务器失败，请重新登录');
      showAuth(error.message);
    }
  }

  window.openComposer = openComposer;
  window.closeComposer = closeComposer;
  window.openFriendHub = openFriendHub;
  window.closeFriendHub = closeFriendHub;
  window.setFriendTab = setFriendTab;
  window.renderFriendHub = renderFriendHub;
  window.publishPost = publishPost;
  window.openDeleteDialog = openDeleteDialog;
  window.closeDeleteDialog = closeDeleteDialog;
  window.confirmDeletePost = confirmDeletePost;
  window.addFriend = addFriend;
  window.toast = toast;

  start();
}());
