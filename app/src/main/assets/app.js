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
  let selectedOnlineTrack = null;
  let musicSearchOffset = 0;
  let authMode = 'register';
  let hubLoadId = 0;
  let currentFeed = 'friends';
  let currentCategory = '';
  let selectedMediaFiles = [];
  let dmState = { conversations: [], currentId: null, currentOther: null, unread: 0, pollTimer: null, chatTimer: null, sending: false };
  // 全屏页面视图：profile（他人/自己主页）、friends（好友）、dm-list（消息列表）、dm-chat（私信聊天）。
  // 用整页视图替代弹窗：页面内容渲染进 #pageView，主 feed 区 .layout 隐藏，底部导航保持可见。
  let pageViewState = { name: null, userId: null };
  const CATEGORY_LIST = ['日常', '美食', '旅行', '心情', '学习', '运动', '其他'];
  const VISIBILITY_LABEL = { public: '公开', friends: '仅好友', private: '仅自己' };

  const toastNode = document.getElementById('toast');
  let toastTimer;
  function toast(message) {
    toastNode.textContent = message;
    toastNode.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastNode.classList.remove('show'); }, 2300);
  }

  function iconSvg(name) {
    const paths = {
      heart: '<path d="M20.8 8.7c0 5.2-8.8 10.5-8.8 10.5S3.2 13.9 3.2 8.7A4.7 4.7 0 0 1 12 6.1a4.7 4.7 0 0 1 8.8 2.6Z"/>',
      comment: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-5.5A7.5 7.5 0 1 1 20 11.5Z"/>',
      share: '<path d="M12 15V3m0 0L7 8m5-5 5 5"/><path d="M5 13v7h14v-7"/>',
      user: '<circle cx="12" cy="8" r="3.5"/><path d="M4 21a8 8 0 0 1 16 0"/>',
      music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
      trash: '<path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/>',
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || '') + '</svg>';
  }

  function makeIconAction(iconName, label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className || 'reaction icon-label';
    button.insertAdjacentHTML('afterbegin', iconSvg(iconName));
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    return button;
  }

  function normalizeServer(value) {
    const server = String(value || '').trim();
    if (!server) throw new Error('请输入服务器地址；普通用户安装应用后会自动连接。');
    const url = new URL(server);
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

  // 有真实头像显示 img，没有则回退 >_< 占位符。
  // 点头像进他人主页（全屏页面，不是弹窗）。stopPropagation 避免触发外层卡片的点击。
  function avatarNode(user, extraClass) {
    let node;
    if (user && user.avatarUrl) {
      const img = document.createElement('img');
      img.className = 'avatar' + (extraClass ? ' ' + extraClass : '');
      img.src = mediaUrl(user.avatarUrl);
      img.alt = user.displayName || '头像';
      img.loading = 'lazy';
      img.decoding = 'async';
      node = img;
    } else {
      node = avatarMark(user && user.displayName);
      if (extraClass) node.classList.add(extraClass);
    }
    // 动态对象用 userId，好友/自己用 id。
    const profileId = user && (user.userId || user.id);
    if (profileId) {
      node.classList.add('avatar-click');
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-label', '查看 ' + (user.displayName || '好友') + ' 的主页');
      node.addEventListener('click', function (event) { event.stopPropagation(); openUserProfile(profileId); });
      node.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); openUserProfile(profileId); }
      });
    }
    return node;
  }

  async function uploadAvatar(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('请选择图片作为头像'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('头像不能超过 5 MB'); return; }
    // 先裁剪放大再上传，不直接传原图
    openAvatarCrop(file);
    return;
  }

  // 头像裁剪：圆形预览 + 拖动平移 + 滑块放大，裁成 512x512 再上传
  function openAvatarCrop(file) {
    const old = document.getElementById('avatarCropBackdrop');
    if (old) old.remove();
    const url = URL.createObjectURL(file);
    const backdrop = document.createElement('div');
    backdrop.id = 'avatarCropBackdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:60;display:flex;align-items:center;justify-content:center;padding:20px';
    backdrop.innerHTML = '<div style="background:#fff;width:min(360px,100%);border-radius:18px;padding:18px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>裁剪头像</b><button id="avatarCropClose" style="border:0;background:#f1f1ee;width:28px;height:28px;border-radius:50%;font-size:16px">×</button></div>' +
      '<div id="avatarCropBox" style="position:relative;width:280px;height:280px;margin:0 auto;overflow:hidden;background:#111;border-radius:12px;touch-action:none;cursor:grab">' +
      '<img id="avatarCropImg" src="' + url + '" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(1);transform-origin:center;max-width:none;user-select:none;-webkit-user-drag:none">' +
      '<div style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at center, transparent 108px, rgba(0,0,0,.55) 109px)"></div>' +
      '<div style="position:absolute;left:50%;top:50%;width:216px;height:216px;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:50%;pointer-events:none;box-sizing:border-box"></div></div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin:14px 4px 0;font-size:12px;color:#777"><span>缩小</span><input id="avatarCropZoom" type="range" min="1" max="3" step="0.05" value="1" style="flex:1"><span>放大</span></div>' +
      '<p style="font-size:11px;color:#999;margin:8px 4px 0">拖动图片调整位置，滑动放大，圆内就是头像</p>' +
      '<div style="display:flex;gap:10px;margin-top:14px"><button id="avatarCropCancel" style="flex:1;border:1px solid #ddd;background:#fff;border-radius:16px;padding:10px">取消</button><button id="avatarCropConfirm" style="flex:1;border:0;background:#171717;color:#fff;border-radius:16px;padding:10px">确定上传</button></div></div>';
    document.body.appendChild(backdrop);
    const img = backdrop.querySelector('#avatarCropImg');
    const box = backdrop.querySelector('#avatarCropBox');
    const zoomInput = backdrop.querySelector('#avatarCropZoom');
    let scale = 1, dx = 0, dy = 0, startX = 0, startY = 0, startDx = 0, startDy = 0, dragging = false;
    let baseW = 0, baseH = 0;
    function apply() { img.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(' + scale + ')'; }
    img.onload = function () {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const fit = Math.max(280 / iw, 280 / ih);
      baseW = iw * fit; baseH = ih * fit;
      img.style.width = baseW + 'px'; img.style.height = baseH + 'px';
      apply();
    };
    zoomInput.addEventListener('input', function () { scale = parseFloat(zoomInput.value); apply(); });
    box.addEventListener('pointerdown', function (e) { dragging = true; startX = e.clientX; startY = e.clientY; startDx = dx; startDy = dy; box.setPointerCapture(e.pointerId); });
    box.addEventListener('pointermove', function (e) { if (!dragging) return; dx = startDx + (e.clientX - startX); dy = startDy + (e.clientY - startY); const max = 140; dx = Math.max(-max, Math.min(max, dx)); dy = Math.max(-max, Math.min(max, dy)); apply(); });
    box.addEventListener('pointerup', function () { dragging = false; });
    function close() { URL.revokeObjectURL(url); backdrop.remove(); }
    backdrop.querySelector('#avatarCropClose').onclick = close;
    backdrop.querySelector('#avatarCropCancel').onclick = close;
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    backdrop.querySelector('#avatarCropConfirm').onclick = async function () {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 512;
        const ctx = canvas.getContext('2d');
        // 圆内区域对应原图：box 280px 对应 512px，圆直径 216px
        const s = 512 / 280;
        ctx.save();
        ctx.beginPath(); ctx.arc(256, 256, 256, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 512, 512);
        const drawW = baseW * scale * s, drawH = baseH * scale * s;
        ctx.drawImage(img, 256 - drawW / 2 + dx * s, 256 - drawH / 2 + dy * s, drawW, drawH);
        ctx.restore();
        const blob = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', 0.92); });
        if (!blob) { toast('裁剪失败，请重试'); return; }
        const cropped = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
        close();
        await uploadAvatarCropped(cropped);
      } catch (err) { toast('裁剪失败，请重试'); }
    };
  }

  async function uploadAvatarCropped(file) {
    const form = new FormData();
    form.append('avatar', file, file.name);
    try {
      const result = await request('/api/me/avatar', { method: 'POST', body: form });
      if (me) me.avatarUrl = result.avatarUrl;
      renderProfile();
      await loadMyProfile();
      toast('头像已更换');
    } catch (error) { toast(error.message); }
  }

  function replaceSampleAvatars() {
    document.querySelectorAll('img.avatar').forEach(function (image) {
      image.replaceWith(avatarMark('留白账号'));
    });
    document.querySelectorAll('.post').forEach(function (post) { post.remove(); });
  }

  // ---------- 全屏页面视图（替代弹窗） ----------
  function pageViewEl() { return document.getElementById('pageView'); }
  function setNavActive(label) {
    document.querySelectorAll('.mobile-nav button').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('aria-label') === label);
    });
  }
  function showPageView(name) {
    const view = pageViewEl();
    if (!view) return;
    pageViewState.name = name;
    const layout = document.querySelector('.layout');
    if (layout) layout.style.display = 'none';
    view.hidden = false;
    view.classList.add('open');
    view.replaceChildren();
    window.scrollTo({ top: 0 });
    setNavActive(name === 'profile' ? '我的' : name === 'friends' ? '好友' : name === 'dm-list' || name === 'dm-chat' ? '消息' : '日常');
  }
  function showFeed() {
    const view = pageViewEl();
    pageViewState = { name: null, userId: null };
    if (view) { view.hidden = true; view.classList.remove('open'); view.replaceChildren(); }
    const layout = document.querySelector('.layout');
    if (layout) layout.style.display = '';
    window.scrollTo({ top: 0 });
    setNavActive('日常');
  }
  function pageHead(title, backLabel, onBack) {
    const head = document.createElement('div');
    head.className = 'page-head';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'page-back';
    back.textContent = backLabel || '返回';
    back.addEventListener('click', onBack);
    const heading = document.createElement('h2');
    heading.textContent = title;
    head.append(back, heading);
    return head;
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
      '.server-settings input{margin-top:0}',
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
      '.comment-avatar{width:24px;height:24px;font-size:8px}',
      '.comment-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.profile-avatar-btn{border:1px solid var(--line);background:#fff;border-radius:16px;padding:6px 10px;font-size:11px}',
      '.feed-empty{background:#fff;border:1px solid var(--line);border-radius:20px;text-align:center;color:#777;padding:42px 20px;font-size:13px;line-height:1.9}',
      '.feed-empty b{display:block;font-size:22px;color:#171717;margin-bottom:8px}',
      '.profile-backdrop{position:fixed;inset:0;background:#0008;z-index:40;display:none;align-items:center;justify-content:center;padding:18px}',
      '.profile-backdrop.open{display:flex}',
      '.profile-page{width:min(760px,100%);height:min(88vh,900px);background:#f6f6f4;border:1px solid #171717;border-radius:24px;overflow:auto;padding:18px 20px 26px;box-shadow:0 24px 90px #0004}',
      '.profile-page-head{position:sticky;top:-18px;z-index:2;display:flex;align-items:center;gap:12px;background:#f6f6f4ed;backdrop-filter:blur(12px);margin:-18px -20px 16px;padding:14px 20px;border-bottom:1px solid var(--line)}',
      '.profile-page-head h2{flex:1;margin:0;font-size:17px}',
      '.profile-page-head button,.profile-publish{border:1px solid var(--line);background:#fff;border-radius:18px;padding:8px 12px;font-size:11px}',
      '.profile-summary-card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:20px;margin-bottom:20px}',
      '.profile-summary-top{display:flex;align-items:center;gap:14px}',
      '.profile-avatar{width:58px;height:58px;font-size:17px;border-radius:50%}',
      '.profile-display-name{font-weight:700;font-size:18px}',
      '.profile-handle,.profile-joined{font-size:11px;color:#777;margin-top:4px}',
      '.profile-stats{display:grid;grid-template-columns:repeat(3,1fr);margin-top:18px;border-top:1px solid var(--line);padding-top:15px;text-align:center}',
      '.profile-stat b{display:block;font-size:16px}.profile-stat span{display:block;font-size:10px;color:#777;margin-top:4px}',
      '.profile-actions{display:flex;justify-content:flex-end;margin-top:14px}',
      '.profile-publish{background:#171717;color:#fff;border-color:#171717}',
      '.profile-post-title{font-size:15px;margin:0 0 12px}',
      '.profile-posts .post{margin-bottom:13px}',
      '#deleteModal{z-index:70}',
      '.me-card{cursor:pointer}',
      '.post-media{max-height:480px}',
      '.top-right .account-button{border:1px solid #171717;border-radius:50%;width:35px;height:35px;background:#171717;color:white;font-size:10px;font-weight:700;letter-spacing:-1px}',
      '.top-right .account-button svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.8}',
      '@media(max-width:700px){.auth-card,.account-card{padding:21px}.composer-tools{margin-left:0;justify-content:space-between}.post{padding:14px 15px}.post-foot{gap:14px}}',
      '@media(max-width:600px){.profile-backdrop{padding:0}.profile-page{width:100%;height:100dvh;max-height:100dvh;border:0;border-radius:0;padding:calc(18px + env(safe-area-inset-top)) 14px calc(18px + env(safe-area-inset-bottom))}.profile-page-head{top:0;margin-top:calc(-18px - env(safe-area-inset-top));margin-left:-14px;margin-right:-14px;padding:calc(14px + env(safe-area-inset-top)) 14px 14px}.profile-summary-card{padding:17px}.profile-avatar{width:52px;height:52px}}',
      '.feed-tabs{display:flex;gap:8px;margin:0 0 14px}.feed-tabs button{border:1px solid var(--line);background:#fff;border-radius:18px;padding:8px 16px;font-size:12px;color:#777}.feed-tabs button.active{background:#171717;color:#fff;border-color:#171717}',
      '.category-chips{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 16px}.category-chips button{border:1px solid var(--line);background:#fff;border-radius:14px;padding:6px 11px;font-size:11px;color:#777}.category-chips button.active{background:#171717;color:#fff;border-color:#171717}',
      '.post-meta{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}.post-meta span{border-radius:12px;padding:4px 8px;font-size:10px;background:#f1f1ee;color:#555}.post-meta .cat{background:#171717;color:#fff}',
      '.media-grid{display:grid;gap:6px;margin:12px 0}.media-grid.one{grid-template-columns:1fr}.media-grid.two{grid-template-columns:1fr 1fr}.media-grid.many{grid-template-columns:repeat(3,1fr)}.media-grid .grid-item{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:12px;cursor:pointer;background:#ecece8}.media-grid.one .grid-item{aspect-ratio:auto;max-height:480px}.media-grid video.grid-item{aspect-ratio:auto;max-height:360px}',
      '.lightbox-backdrop{position:fixed;inset:0;background:#000d;z-index:120;display:none;align-items:center;justify-content:center}.lightbox-backdrop.open{display:flex}.lightbox-inner{max-width:min(92vw,900px);max-height:92vh;display:flex;flex-direction:column;align-items:center;gap:12px}.lightbox-inner img,.lightbox-inner video{max-width:100%;max-height:76vh;border-radius:12px;background:#000}.lightbox-bar{display:flex;gap:10px;align-items:center;color:#fff;font-size:12px}.lightbox-bar button{border:1px solid #fff;background:transparent;color:#fff;border-radius:18px;padding:7px 14px}',
      '.comment-row.reply{margin-left:24px;border-left:2px solid var(--line);padding-left:10px}.comment-reply-btn{border:0;background:none;color:#777;font-size:11px;margin-left:8px;cursor:pointer}.comment-reply-box{margin:6px 0 6px 24px;display:flex;gap:6px}.comment-reply-box input{flex:1;border:1px solid var(--line);border-radius:16px;padding:8px 11px;font-size:12px;outline:none}.comment-reply-box button{border:0;background:#171717;color:#fff;border-radius:16px;padding:8px 12px;font-size:11px}',
      '.composer-meta{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.composer-meta label{font-size:11px;color:#555;display:flex;align-items:center;gap:6px}.composer-meta select{border:1px solid var(--line);border-radius:10px;padding:7px 9px;font-size:11px;background:#fff;outline:none}',
      '.preview-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.preview-grid img,.preview-grid video{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:10px}',
      '.preview-item{position:relative}.preview-item img,.preview-item video{display:block}.preview-remove{position:absolute;top:4px;right:4px;z-index:2;width:24px;height:24px;border:0;border-radius:50%;background:#000b;color:#fff;font-size:15px;line-height:1;cursor:pointer}.preview-clear-row{grid-column:1/-1;text-align:right}.preview-clear{border:1px solid var(--line);background:#fff;border-radius:14px;padding:6px 11px;font-size:11px;color:#555}',
      '.dm-badge{display:none;position:absolute;top:2px;right:2px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#d33;color:#fff;font-size:10px;line-height:16px;text-align:center}.dm-badge.show{display:block}.mobile-nav button{position:relative}',
      '.dm-list{max-height:52vh;overflow:auto}.dm-item{display:flex;align-items:center;gap:11px;padding:12px 4px;border-bottom:1px solid var(--line);cursor:pointer;text-align:left;width:100%;background:none;border-left:0;border-right:0;border-top:0}.dm-item .avatar{width:44px;height:44px}.dm-item-copy{min-width:0;flex:1}.dm-item-name{font-weight:600;font-size:13px}.dm-item-last{font-size:12px;color:#777;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.dm-item-time{font-size:10px;color:#999;white-space:nowrap}.dm-item-unread{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#d33;color:#fff;font-size:11px;line-height:18px;text-align:center}',
      '.dm-chat-backdrop{position:fixed;inset:0;background:#0008;z-index:50;display:none;align-items:center;justify-content:center;padding:18px}.dm-chat-backdrop.open{display:flex}.dm-chat{width:min(560px,100%);height:min(80vh,720px);background:#f6f6f4;border-radius:22px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 90px #0004}.dm-chat-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);background:#fff}.dm-chat-head h3{flex:1;margin:0;font-size:15px}.dm-chat-head button{border:1px solid var(--line);background:#fff;border-radius:16px;padding:7px 11px;font-size:11px}.dm-messages{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}.dm-bubble{max-width:78%;padding:9px 12px;border-radius:14px;font-size:13px;line-height:1.6;word-break:break-word;background:#fff;border:1px solid var(--line)}.dm-bubble.mine{align-self:flex-end;background:#171717;color:#fff;border-color:#171717}.dm-time{font-size:10px;color:#999;margin-top:2px}.dm-bubble.mine + .dm-time{align-self:flex-end}.dm-input-row{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line);background:#fff}.dm-input-row input{flex:1;min-width:0;border:1px solid var(--line);border-radius:18px;padding:10px 13px;outline:none}.dm-input-row button{border:0;background:#171717;color:#fff;border-radius:18px;padding:10px 16px;font-size:12px}.dm-input-row button:disabled{opacity:.5}',
      '.dm-empty{text-align:center;color:#777;font-size:12px;padding:32px 12px}.dm-btn{border:1px solid var(--line);background:#fff;border-radius:14px;padding:5px 9px;font-size:11px;white-space:nowrap}',
      '.page-view{display:none;max-width:740px;margin:0 auto;padding:16px 16px 90px}.page-view.open{display:block}',
      '.page-head{display:flex;align-items:center;gap:12px;background:#f6f6f4;padding:12px 0;border-bottom:1px solid var(--line);margin-bottom:14px}',
      '.page-head h2{flex:1;margin:0;font-size:16px}',
      '.page-back{border:1px solid var(--line);background:#fff;border-radius:18px;padding:8px 12px;font-size:12px}',
      '.page-view .profile-page{width:100%;height:auto;max-height:none;background:transparent;border:0;border-radius:0;overflow:visible;padding:0;box-shadow:none}',
      '.page-view .profile-page-head{display:none}',
      '.dm-page-list{overflow:visible}',
      '.dm-page-chat{display:flex;flex-direction:column;height:100%;overflow:hidden}',
      '.dm-page-messages{flex:1;overflow-y:auto;padding:14px 0;display:flex;flex-direction:column;gap:8px}',
      '.dm-page-input{display:flex;gap:8px;padding:12px 0; border-top:1px solid var(--line);background:#f6f6f4;position:static}',
      '.dm-page-input input{flex:1;min-width:0;border:1px solid var(--line);border-radius:18px;padding:10px 13px;outline:none;background:#fff}',
      '.dm-page-input button{border:0;background:#171717;color:#fff;border-radius:18px;padding:10px 16px;font-size:12px}',
      '.dm-page-input button:disabled{opacity:.5}',
      '.friend-page-list{overflow:visible;max-height:none}',
      '.post-author-btn{border:0;background:none;padding:0;text-align:left;cursor:pointer;font:inherit;font-weight:600}',
      '.avatar-click{cursor:pointer}'
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
      '<details class="server-settings" id="serverSettings"><summary>服务器设置（一般不需要修改）</summary><label for="serverAddress">服务器地址</label><input id="serverAddress" type="url" inputmode="url" placeholder="https://服务器IP" autocomplete="url"><small>默认已连接留白服务器；只有更换服务器时才需要修改。</small></details>' +
      '<label for="authUsername">账号名</label><input id="authUsername" maxlength="24" autocomplete="username" placeholder="3–24 位字母、数字或下划线">' +
      '<div id="nicknameField"><label for="authNickname">昵称</label><input id="authNickname" maxlength="24" autocomplete="nickname" placeholder="朋友看到的名字"></div>' +
      '<label for="authPassword">密码</label><input id="authPassword" type="password" maxlength="128" autocomplete="new-password" placeholder="至少 8 位">' +
      '<p class="auth-error" id="authError" aria-live="polite"></p>' +
      '<div class="auth-actions"><button id="authSubmit" type="button">创建账号</button></div>' +
      '<button class="auth-switch" id="authSwitch" type="button">已有账号？登录</button></section>';
    document.body.appendChild(layer);
    document.getElementById('serverAddress').value = apiBase;
    document.getElementById('serverSettings').open = !apiBase;
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
      apiBase = normalizeServer(document.getElementById('serverAddress').value.trim() || apiBase);
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
    button.addEventListener('click', openMyProfile);

    const layer = document.createElement('div');
    layer.className = 'account-backdrop';
    layer.id = 'accountDialog';
    layer.innerHTML = '<section class="account-card" role="dialog" aria-modal="true"><div class="eyebrow">MY LITTLE SPACE</div>' +
      '<h2 id="accountName">我的账号</h2><p id="accountInfo"></p>' +
      '<div class="account-actions"><button class="secondary" id="accountClose">返回</button><button id="logoutButton">退出账号</button></div>' +
      '<div class="account-actions"><button class="secondary" id="changeAvatarButton">更换头像</button><input type="file" id="accountAvatarInput" accept="image/jpeg,image/png,image/webp,image/gif" hidden></div></section>';
    layer.addEventListener('click', function (event) { if (event.target === layer) layer.classList.remove('open'); });
    document.body.appendChild(layer);
    document.getElementById('accountClose').addEventListener('click', function () { layer.classList.remove('open'); });
    document.getElementById('logoutButton').addEventListener('click', logout);
    document.getElementById('changeAvatarButton').addEventListener('click', function () { document.getElementById('accountAvatarInput').click(); });
    document.getElementById('accountAvatarInput').addEventListener('change', function (event) { uploadAvatar(event.target.files && event.target.files[0]); event.target.value = ''; });
  }

  function installProfilePage() {
    // 主页是全屏页面（#pageView），不再建弹窗层。只接线侧边“我的”卡片。
    const card = document.querySelector('.me-card');
    if (card) {
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('click', openMyProfile);
      card.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMyProfile(); }
      });
    }
  }

  let profileLoadId = 0;
  function openMyProfile() {
    if (!me) return showAuth();
    return openUserProfile(me.id);
  }

  function closeMyProfile() {
    if (pageViewState.name === 'profile') showFeed();
  }

  // 他人主页（全屏页面，不是弹窗）：头像、昵称、简介、动态数/好友数/获赞数 + 该用户动态列表。
  async function openUserProfile(userId) {
    if (!me) return showAuth();
    const targetId = Number(userId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return;
    showPageView('profile');
    pageViewState.userId = targetId;
    const view = pageViewEl();
    const loadId = ++profileLoadId;
    view.appendChild(pageHead('个人主页', '返回', showFeed));
    const summary = document.createElement('div');
    summary.textContent = '正在加载个人主页…';
    view.appendChild(summary);
    const postsTitle = document.createElement('h3');
    postsTitle.className = 'profile-post-title';
    postsTitle.textContent = '日常';
    view.appendChild(postsTitle);
    const postsHost = document.createElement('div');
    postsHost.className = 'profile-posts';
    view.appendChild(postsHost);
    try {
      const values = await Promise.all([
        request('/api/users/' + targetId),
        request('/api/posts?userId=' + targetId),
      ]);
      if (loadId !== profileLoadId || pageViewState.name !== 'profile' || pageViewState.userId !== targetId) return;
      const user = values[0];
      const posts = values[1].posts || [];
      if (user.isSelf) me = { ...me, ...user };
      renderProfile();
      summary.replaceChildren();

      const card = document.createElement('section');
      card.className = 'profile-summary-card';
      const top = document.createElement('div');
      top.className = 'profile-summary-top';
      const avatar = avatarNode(user);
      avatar.classList.add('profile-avatar');
      const identity = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'profile-display-name';
      name.textContent = user.displayName || '留白用户';
      const handle = document.createElement('div');
      handle.className = 'profile-handle';
      handle.textContent = '@' + user.username;
      const joined = document.createElement('div');
      joined.className = 'profile-joined';
      const created = new Date(user.createdAt);
      joined.textContent = Number.isNaN(created.getTime()) ? '留白好友' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(created) + ' 加入留白';
      identity.append(name, handle, joined);
      top.append(avatar, identity);
      if (user.bio) {
        const bio = document.createElement('div');
        bio.className = 'profile-handle';
        bio.style.marginTop = '10px';
        bio.style.color = '#555';
        bio.style.whiteSpace = 'pre-wrap';
        bio.textContent = user.bio;
        identity.appendChild(bio);
      }
      const stats = document.createElement('div');
      stats.className = 'profile-stats';
      [[user.postCount || 0, '日常'], [user.friendCount || 0, '好友'], [user.likeCount || 0, '获赞']].forEach(function (item) {
        const stat = document.createElement('div');
        stat.className = 'profile-stat';
        const count = document.createElement('b');
        count.textContent = String(item[0]);
        const label = document.createElement('span');
        label.textContent = item[1];
        stat.append(count, label);
        stats.appendChild(stat);
      });
      const actions = document.createElement('div');
      actions.className = 'profile-actions';
      if (user.isSelf) {
        const changeAvatar = document.createElement('button');
        changeAvatar.type = 'button';
        changeAvatar.className = 'profile-avatar-btn';
        changeAvatar.textContent = '更换头像';
        const avatarInput = document.createElement('input');
        avatarInput.type = 'file';
        avatarInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
        avatarInput.hidden = true;
        avatarInput.addEventListener('change', function (event) { uploadAvatar(event.target.files && event.target.files[0]); event.target.value = ''; });
        changeAvatar.addEventListener('click', function () { avatarInput.click(); });
        actions.append(changeAvatar, avatarInput);
        const account = document.createElement('button');
        account.type = 'button';
        account.className = 'profile-avatar-btn';
        account.textContent = '账号设置';
        account.addEventListener('click', openAccount);
        actions.appendChild(account);
        const publish = document.createElement('button');
        publish.type = 'button';
        publish.className = 'profile-publish';
        publish.textContent = '发布日常';
        publish.addEventListener('click', function () { closeMyProfile(); openComposer(); });
        actions.appendChild(publish);
      } else {
        const dm = document.createElement('button');
        dm.type = 'button';
        dm.className = 'profile-publish';
        dm.textContent = '私信';
        dm.addEventListener('click', function () { startDmWith(targetId); });
        actions.appendChild(dm);
        if (!user.isFriend) {
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'profile-avatar-btn';
          add.textContent = '添加好友';
          add.addEventListener('click', function () { addFriend(targetId); });
          actions.appendChild(add);
        } else {
          const tag = document.createElement('span');
          tag.className = 'friend-state';
          tag.textContent = '已是好友';
          actions.appendChild(tag);
        }
      }
      card.append(top, stats, actions);
      summary.appendChild(card);

      if (!posts.length) {
        const empty = document.createElement('div');
        empty.className = 'feed-empty';
        empty.innerHTML = '<b>&gt;_&lt;</b><span>还没有发布日常。</span>';
        postsHost.appendChild(empty);
      } else posts.forEach(function (post) { postsHost.appendChild(makePost(post)); });
    } catch (error) {
      if (loadId !== profileLoadId) return;
      summary.textContent = error.message || '个人主页暂时无法加载。';
    }
  }

  function loadMyProfile() {
    return openUserProfile(me && me.id);
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
    dmState.conversations = []; dmState.unread = 0; dmState.currentId = null;
    if (dmState.pollTimer) { clearInterval(dmState.pollTimer); dmState.pollTimer = null; }
    if (dmState.chatTimer) { clearInterval(dmState.chatTimer); dmState.chatTimer = null; }
    updateDmBadge();
    localStorage.removeItem(TOKEN_KEY);
    document.getElementById('accountDialog').classList.remove('open');
    closeMyProfile();
    showFeed();
    renderEmptyFeed('登录后查看好友的日常');
    renderProfile();
    showAuth('已退出账号。');
  }

  function refreshStaticAvatars() {
    if (!me) return;
    const host = document.querySelector('.me-card .avatar');
    if (host && me.avatarUrl) {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.src = mediaUrl(me.avatarUrl);
      img.alt = me.displayName || '我的头像';
      host.replaceWith(img);
    }
    const composerAvatar = document.querySelector('.composer-top .avatar');
    if (composerAvatar && me.avatarUrl) {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.src = mediaUrl(me.avatarUrl);
      img.alt = '';
      composerAvatar.replaceWith(img);
    }
  }

  function renderProfile() {
    refreshStaticAvatars();
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
    if (accountButton) accountButton.innerHTML = iconSvg('user');
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

  // 动态流里用小图：Unsplash 示例图把 w=1100 换成 w=800；服务器本地图暂无缩略图接口，保持原图（靠懒加载省流量）。
  function feedThumbUrl(value) {
    const url = mediaUrl(value);
    if (!url) return url;
    return url.replace(/([?&]w=)\d+/, '$1800');
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
    header.appendChild(avatarNode(post));
    const who = document.createElement('div');
    const author = document.createElement('button');
    author.type = 'button';
    author.className = 'post-author post-author-btn';
    author.textContent = post.displayName;
    author.setAttribute('aria-label', '查看 ' + post.displayName + ' 的主页');
    author.addEventListener('click', function (event) { event.stopPropagation(); openUserProfile(post.userId); });
    const time = document.createElement('div');
    time.className = 'post-time';
    time.textContent = formatTime(post.createdAt) + ' · @' + post.username;
    who.append(author, time);
    header.appendChild(who);
    if (!post.owned) {
      const dmBtn = document.createElement('button');
      dmBtn.type = 'button';
      dmBtn.className = 'dm-btn';
      dmBtn.textContent = '私信';
      dmBtn.setAttribute('aria-label', '私信 ' + post.displayName);
      dmBtn.addEventListener('click', function () { startDmWith(post.userId); });
      header.appendChild(dmBtn);
    }
    if (post.owned) {
      const more = makeIconAction('trash', '删除', 'more icon-label');
      more.setAttribute('aria-label', '删除这条日常');
      more.addEventListener('click', function () { openDeleteDialog(article); });
      header.appendChild(more);
    }
    article.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'post-meta';
    const cat = document.createElement('span');
    cat.className = 'cat';
    cat.textContent = post.category || '日常';
    const vis = document.createElement('span');
    vis.textContent = VISIBILITY_LABEL[post.visibility] || '仅好友';
    meta.append(cat, vis);
    article.appendChild(meta);

    if (post.text) {
      const copy = document.createElement('p');
      copy.className = 'post-copy';
      copy.textContent = post.text;
      article.appendChild(copy);
    }
    if (post.music) {
      const music = document.createElement('div');
      music.className = 'music-chip icon-label';
      music.insertAdjacentHTML('afterbegin', iconSvg('music'));
      const musicTitle = document.createElement('span');
      musicTitle.textContent = post.music;
      music.appendChild(musicTitle);
      article.appendChild(music);
    }
    const mediaItems = Array.isArray(post.media) && post.media.length ? post.media : (post.mediaUrl ? [{ type: post.mediaType || '', url: post.mediaUrl }] : []);
    if (mediaItems.length) {
      const grid = document.createElement('div');
      grid.className = 'media-grid ' + (mediaItems.length === 1 ? 'one' : mediaItems.length === 2 ? 'two' : 'many');
      mediaItems.forEach(function (item, index) {
        let media;
        if (String(item.type || '').startsWith('video/')) {
          media = document.createElement('video');
          media.controls = true;
          media.playsInline = true;
          media.preload = 'metadata';
        } else {
          media = document.createElement('img');
          media.alt = '日常照片';
          // 动态图片懒加载：滑到才加载，解码不阻塞主线程；低清占位背景在 CSS 里（.grid-item 背景色）。
          // 示例图（Unsplash）用 w=800 小图，点开灯箱再看原图；服务器本地图片暂无缩略图接口，用原图 + 懒加载。
          media.loading = 'lazy';
          media.decoding = 'async';
        }
        media.className = 'grid-item';
        media.src = feedThumbUrl(item.url);
        media.addEventListener('click', function () { openLightbox(mediaItems, index); });
        grid.appendChild(media);
      });
      article.appendChild(grid);
    }
    if (post.audioUrl) {
      const audio = document.createElement('audio');
      audio.className = 'post-audio';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = mediaUrl(post.audioUrl);
      article.appendChild(audio);
    }
    if (post.musicTrackId) {
      const audio = document.createElement('audio');
      audio.className = 'post-audio';
      audio.controls = true;
      audio.preload = 'none';
      const isItunesPost = post.musicSource === 'itunes';
      if (isItunesPost && post.musicPreviewUrl) {
        audio.src = post.musicPreviewUrl;
      } else if (isItunesPost) {
        audio.src = apiBase + '/api/music/tracks/' + encodeURIComponent(post.musicTrackId) + '/audio?source=itunes';
      } else {
        audio.src = apiBase + '/api/music/tracks/' + encodeURIComponent(post.musicTrackId) + '/audio';
      }
      audio.setAttribute('aria-label', '播放配乐：' + (post.music || '在线音乐'));
      article.appendChild(audio);
      const credit = document.createElement('small');
      credit.className = 'post-music-credit';
      const creator = document.createElement('span');
      if (isItunesPost) {
        creator.textContent = '创作者：' + (post.musicArtist || '未知创作者') + ' · iTunes · 30秒试听 · 音乐来源：';
      } else {
        creator.textContent = '创作者：' + (post.musicArtist || 'Jamendo 音乐人') + ' · 音乐来源：';
      }
      const source = document.createElement('a');
      source.href = post.musicPageUrl || (isItunesPost ? 'https://music.apple.com/search?term=' + encodeURIComponent(post.music || '') : ('https://www.jamendo.com/track/' + encodeURIComponent(post.musicTrackId)));
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = isItunesPost ? 'Apple Music 曲目页' : 'Jamendo 曲目页';
      credit.append(creator, source);
      article.appendChild(credit);
    }

    const footer = document.createElement('div');
    footer.className = 'post-foot';
    const like = makeIconAction('heart', String(post.likeCount), 'reaction like icon-label' + (post.liked ? ' liked' : ''));
    like.addEventListener('click', async function () {
      try {
        const result = await request('/api/posts/' + post.id + '/like', { method: post.liked ? 'DELETE' : 'POST' });
        post.liked = result.liked;
        post.likeCount += post.liked ? 1 : -1;
        like.querySelector('span').textContent = String(post.likeCount);
        like.classList.toggle('liked', post.liked);
      } catch (error) { toast(error.message); }
    });
    const commentButton = makeIconAction('comment', '评论', 'reaction comment-toggle icon-label');
    const shareButton = makeIconAction('share', '分享', 'reaction share icon-label');
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
        result.comments.forEach(function (item) { list.appendChild(makeComment(item, post.id, list)); });
        commentsLoaded = true;
      } catch (error) { toast(error.message); }
    });
    input.addEventListener('keydown', async function (event) {
      if (event.key !== 'Enter' || !input.value.trim()) return;
      event.preventDefault();
      const value = input.value.trim();
      input.disabled = true;
      try {
        const created = await request('/api/posts/' + post.id + '/comments', { method: 'POST', body: { text: value } });
        list.appendChild(makeComment({ id: created.id, displayName: me.displayName, username: me.username, avatarUrl: me.avatarUrl, text: value, parentId: null }, post.id, list));
        input.value = '';
        commentsLoaded = true;
      } catch (error) { toast(error.message); }
      finally { input.disabled = false; }
    });
    return article;
  }

  function makeComment(comment, postId, listNode) {
    const row = document.createElement('div');
    const isReply = !!comment.parentId;
    row.className = 'comment-row' + (isReply ? ' reply' : '');
    row.appendChild(avatarNode(comment, 'comment-avatar'));
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = comment.displayName + '：';
    const text = document.createElement('span');
    text.textContent = (isReply && (comment.parentDisplayName || comment.parentUsername) ? '回复 @' + (comment.parentDisplayName || comment.parentUsername) + '：' : '') + comment.text;
    row.append(author, text);
    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'comment-reply-btn';
    replyBtn.textContent = '回复';
    replyBtn.addEventListener('click', function () {
      if (row.nextSibling && row.nextSibling.classList && row.nextSibling.classList.contains('comment-reply-box')) {
        row.nextSibling.remove();
        return;
      }
      const box = document.createElement('div');
      box.className = 'comment-reply-box';
      const replyInput = document.createElement('input');
      replyInput.maxLength = 500;
      replyInput.placeholder = '回复 @' + comment.displayName + '…';
      const send = document.createElement('button');
      send.type = 'button';
      send.textContent = '发送';
      send.addEventListener('click', async function () {
        const value = replyInput.value.trim();
        if (!value) return;
        send.disabled = true;
        try {
          const created = await request('/api/posts/' + postId + '/comments', { method: 'POST', body: { text: value, parentId: comment.id } });
          const topId = comment.parentId ? comment.parentId : comment.id;
          const topName = comment.parentId ? (comment.parentDisplayName || comment.parentUsername || comment.displayName) : comment.displayName;
          const newRow = makeComment({ id: created.id, displayName: me.displayName, username: me.username, avatarUrl: me.avatarUrl, text: value, parentId: topId, parentDisplayName: topName }, postId, listNode);
          listNode.appendChild(newRow);
          box.remove();
        } catch (error) { toast(error.message); }
        finally { send.disabled = false; }
      });
      replyInput.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); send.click(); } });
      box.append(replyInput, send);
      row.after(box);
      replyInput.focus();
    });
    row.appendChild(replyBtn);
    return row;
  }

  let lightboxState = { items: [], index: 0 };
  function openLightbox(items, index) {
    let layer = document.getElementById('mediaLightbox');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'lightbox-backdrop';
      layer.id = 'mediaLightbox';
      layer.innerHTML = '<div class="lightbox-inner"><div class="lightbox-stage"></div><div class="lightbox-bar"><button type="button" data-act="prev">上一个</button><span class="lightbox-count"></span><button type="button" data-act="next">下一个</button><button type="button" data-act="close">关闭</button></div></div>';
      layer.addEventListener('click', function (event) { if (event.target === layer) closeLightbox(); });
      document.body.appendChild(layer);
      layer.querySelector('[data-act="prev"]').addEventListener('click', function () { showLightboxItem(lightboxState.index - 1); });
      layer.querySelector('[data-act="next"]').addEventListener('click', function () { showLightboxItem(lightboxState.index + 1); });
      layer.querySelector('[data-act="close"]').addEventListener('click', closeLightbox);
    }
    lightboxState = { items: items, index: index };
    layer.classList.add('open');
    showLightboxItem(index);
  }
  function showLightboxItem(index) {
    const layer = document.getElementById('mediaLightbox');
    if (!layer) return;
    const items = lightboxState.items;
    if (!items.length) return;
    const safe = ((index % items.length) + items.length) % items.length;
    lightboxState.index = safe;
    const stage = layer.querySelector('.lightbox-stage');
    stage.replaceChildren();
    const item = items[safe];
    let node;
    if (String(item.type || '').startsWith('video/')) {
      node = document.createElement('video');
      node.controls = true;
      node.autoplay = true;
      node.playsInline = true;
    } else {
      node = document.createElement('img');
      node.alt = '日常照片';
      node.loading = 'eager';
      node.decoding = 'async';
    }
    node.src = mediaUrl(item.url);
    stage.appendChild(node);
    layer.querySelector('.lightbox-count').textContent = (safe + 1) + ' / ' + items.length;
  }
  function closeLightbox() {
    const layer = document.getElementById('mediaLightbox');
    if (layer) layer.classList.remove('open');
  }

  // ---------- 一对一私信 (DM) ----------
  function updateDmBadge() {
    document.querySelectorAll('.dm-badge').forEach(function (badge) {
      badge.textContent = dmState.unread > 99 ? '99+' : String(dmState.unread);
      badge.classList.toggle('show', dmState.unread > 0);
    });
  }
  async function refreshDmUnread() {
    if (!me) return;
    try {
      const result = await request('/api/dm/unread');
      dmState.unread = result.unread || 0;
      updateDmBadge();
    } catch (_) {}
  }
  function startDmPoll() {
    if (dmState.pollTimer) return;
    dmState.pollTimer = setInterval(refreshDmUnread, 30000);
  }
  function installDmUI() {
    // 私信是全屏页面（#pageView），不再建弹窗层。
  }
  async function openDmList() {
    if (!me) return showAuth();
    if (dmState.chatTimer) { clearInterval(dmState.chatTimer); dmState.chatTimer = null; }
    dmState.currentId = null;
    dmState.currentOther = null;
    showPageView('dm-list');
    const view = pageViewEl();
    view.appendChild(pageHead('消息', '返回', showFeed));
    const body = document.createElement('div');
    body.id = 'dmListBody';
    body.className = 'dm-page-list';
    body.textContent = '正在加载消息…';
    view.appendChild(body);
    try {
      const result = await request('/api/dm/conversations');
      dmState.conversations = result.conversations || [];
      body.replaceChildren();
      if (!dmState.conversations.length) {
        const empty = document.createElement('div');
        empty.className = 'dm-empty';
        empty.textContent = '还没有私信，去好友列表点“私信”开始聊吧。';
        body.appendChild(empty);
        return;
      }
      dmState.conversations.forEach(function (conv) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dm-item';
        item.appendChild(avatarNode(conv.otherUser));
        const copy = document.createElement('div');
        copy.className = 'dm-item-copy';
        const name = document.createElement('div');
        name.className = 'dm-item-name';
        name.textContent = conv.otherUser.displayName;
        const last = document.createElement('div');
        last.className = 'dm-item-last';
        last.textContent = conv.lastMessage ? conv.lastMessage.text : '还没有消息';
        copy.append(name, last);
        const right = document.createElement('div');
        const time = document.createElement('div');
        time.className = 'dm-item-time';
        time.textContent = conv.lastMessage ? formatTime(conv.lastMessage.createdAt) : '';
        right.appendChild(time);
        if (conv.unreadCount > 0) {
          const unread = document.createElement('div');
          unread.className = 'dm-item-unread';
          unread.textContent = String(conv.unreadCount);
          right.appendChild(unread);
        }
        item.append(copy, right);
        item.addEventListener('click', function () { openDmChat(conv.id, conv.otherUser); });
        body.appendChild(item);
      });
    } catch (error) { body.textContent = error.message; }
  }
  function closeDmList() {
    if (pageViewState.name === 'dm-list') showFeed();
  }
  async function startDmWith(otherUserId) {
    if (!me) return showAuth();
    if (Number(otherUserId) === me.id) { toast('不能和自己私信'); return; }
    try {
      const result = await request('/api/dm/conversations', { method: 'POST', body: { otherUserId: Number(otherUserId) } });
      const conv = dmState.conversations.find(function (c) { return c.id === result.id; });
      let other = conv ? conv.otherUser : null;
      if (!other) {
        const list = await request('/api/dm/conversations');
        dmState.conversations = list.conversations || [];
        const found = dmState.conversations.find(function (c) { return c.id === result.id; });
        other = found ? found.otherUser : { id: Number(otherUserId), displayName: '好友', username: '' };
      }
      closeFriendHub();
      openDmChat(result.id, other);
    } catch (error) { toast(error.message); }
  }
  async function loadDmMessages(appendOnly) {
    if (!dmState.currentId) return;
    try {
      const result = await request('/api/dm/conversations/' + dmState.currentId + '/messages');
      const host = document.getElementById('dmMessages');
      if (!host) return;
      const prevCount = host.querySelectorAll('.dm-bubble').length;
      if (appendOnly && result.messages.length === prevCount) return;
      const wasAtBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 120;
      const hasNewFromOther = appendOnly && result.messages.slice(prevCount).some(function (m) { return m.senderId !== me.id; });
      host.replaceChildren();
      result.messages.forEach(function (msg) {
        const bubble = document.createElement('div');
        bubble.className = 'dm-bubble' + (msg.senderId === me.id ? ' mine' : '');
        bubble.textContent = msg.text;
        const time = document.createElement('div');
        time.className = 'dm-time';
        time.textContent = formatTime(msg.createdAt);
        host.append(bubble, time);
      });
      // 打开时一定到底；有对方新消息时也到底；自己在上面翻历史时不抢滚动。
      if (!appendOnly || wasAtBottom || hasNewFromOther) {
        var _scrollBottom = function () { host.scrollTop = host.scrollHeight; };
        requestAnimationFrame(_scrollBottom);
        setTimeout(_scrollBottom, 50);
        setTimeout(_scrollBottom, 200);
      }
      if (hasNewFromOther) {
        try { await request('/api/dm/conversations/' + dmState.currentId + '/read', { method: 'POST' }); } catch (_) {}
      }
    } catch (error) { toast(error.message); }
  }
  async function openDmChat(conversationId, otherUser) {
    if (!me) return showAuth();
    dmState.currentId = Number(conversationId);
    dmState.currentOther = otherUser;
    showPageView('dm-chat');
    const view = pageViewEl();
    view.style.paddingBottom = '0';
    view.style.paddingTop = '0';
    const chat = document.createElement('div');
    chat.className = 'dm-page-chat';
    chat.appendChild(pageHead((otherUser && otherUser.displayName) || '私信', '返回', openDmList));
    const messages = document.createElement('div');
    messages.id = 'dmMessages';
    messages.className = 'dm-messages dm-page-messages';
    chat.appendChild(messages);
    const form = document.createElement('form');
    form.id = 'dmForm';
    form.className = 'dm-page-input';
    const input = document.createElement('input');
    input.id = 'dmInput';
    input.maxLength = 2000;
    input.placeholder = '写点什么…';
    input.autocomplete = 'off';
    const send = document.createElement('button');
    send.id = 'dmSend';
    send.type = 'submit';
    send.textContent = '发送';
    form.append(input, send);
    form.addEventListener('submit', function (event) { event.preventDefault(); sendDmMessage(); });
    chat.appendChild(form);
    view.appendChild(chat);
    // 原生已用 IME 高度改 WebView 高度，这里只在聚焦时滚到底，不要再改 chat 高度，否则会和原生重复顶起、留一大段空白。
    input.addEventListener('focus', function () { setTimeout(function () { var m = document.getElementById('dmMessages'); if (m) m.scrollTop = m.scrollHeight; }, 300); });
    await loadDmMessages(false);
    try { await request('/api/dm/conversations/' + dmState.currentId + '/read', { method: 'POST' }); } catch (_) {}
    await refreshDmUnread();
    if (dmState.chatTimer) clearInterval(dmState.chatTimer);
    dmState.chatTimer = setInterval(function () { if (pageViewState.name === 'dm-chat') { loadDmMessages(true); refreshDmUnread(); } }, 5000);
  }
  function closeDmChat() {
    if (pageViewState.name !== 'dm-chat') return;
    const _v = pageViewEl(); if (_v) { _v.style.paddingBottom = ''; _v.style.paddingTop = ''; }
    if (dmState.chatTimer) { clearInterval(dmState.chatTimer); dmState.chatTimer = null; }
    dmState.currentId = null;
    dmState.currentOther = null;
    refreshDmUnread();
    openDmList();
  }
  async function sendDmMessage() {
    if (!dmState.currentId || dmState.sending) return;
    const input = document.getElementById('dmInput');
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 2000) { toast('私信最多 2000 个字符'); return; }
    dmState.sending = true;
    const sendBtn = document.getElementById('dmSend');
    sendBtn.disabled = true;
    try {
      await request('/api/dm/conversations/' + dmState.currentId + '/messages', { method: 'POST', body: { text: text } });
      input.value = '';
      await loadDmMessages(false);
    } catch (error) { toast(error.message); }
    finally { dmState.sending = false; sendBtn.disabled = false; }
  }

  async function loadFeed() {
    const params = new URLSearchParams({ feed: currentFeed });
    if (currentCategory) params.set('category', currentCategory);
    const result = await request('/api/posts?' + params.toString());
    const host = document.getElementById('posts');
    host.replaceChildren();
    renderFeedTabs(host);
    if (!result.posts.length) {
      const msg = currentFeed === 'square' ? '广场还没有公开动态，去发一条公开的吧' : '发布第一条日常，或者先添加好友吧';
      host.appendChild(feedEmptyNode(msg));
      return;
    }
    result.posts.forEach(function (post) { host.appendChild(makePost(post)); });
  }
  function feedEmptyNode(message) {
    const empty = document.createElement('div');
    empty.className = 'feed-empty';
    const icon = document.createElement('b');
    icon.textContent = '>_<';
    const copy = document.createElement('span');
    copy.textContent = message;
    empty.append(icon, copy);
    return empty;
  }
  function renderFeedTabs(host) {
    const tabs = document.createElement('div');
    tabs.className = 'feed-tabs';
    [['friends', '好友'], ['square', '广场']].forEach(function (item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item[1];
      button.classList.toggle('active', currentFeed === item[0]);
      button.addEventListener('click', function () {
        currentFeed = item[0];
        loadFeed();
      });
      tabs.appendChild(button);
    });
    const chips = document.createElement('div');
    chips.className = 'category-chips';
    [['', '全部'], ...CATEGORY_LIST.map(function (c) { return [c, c]; })].forEach(function (item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item[1];
      button.classList.toggle('active', currentCategory === item[0]);
      button.addEventListener('click', function () {
        currentCategory = item[0];
        loadFeed();
      });
      chips.appendChild(button);
    });
    host.append(tabs, chips);
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
    await refreshDmUnread();
    startDmPoll();
  }

  function personCard(person, subtitle) {
    const row = document.createElement('div');
    row.className = 'friend hub-friend';
    row.appendChild(avatarNode(person));
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
    const search = document.getElementById('friendSearch');
    if (search) search.value = '';
    renderFriendHub();
  }

  function openFriendHub(tab) {
    if (!me) return showAuth();
    friendTab = tab || 'recommend';
    showPageView('friends');
    const view = pageViewEl();
    view.appendChild(pageHead('好友', '返回', showFeed));
    const search = document.createElement('input');
    search.className = 'friend-search';
    search.id = 'friendSearch';
    search.type = 'search';
    search.placeholder = '搜索好友或昵称';
    search.addEventListener('input', renderFriendHub);
    view.appendChild(search);
    const tabs = document.createElement('div');
    tabs.className = 'friend-tabs';
    [['recommend', '推荐'], ['friends', '我的好友'], ['requests', '申请记录']].forEach(function (item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tab = item[0];
      button.textContent = item[1];
      button.classList.toggle('active', friendTab === item[0]);
      button.addEventListener('click', function () { setFriendTab(item[0]); });
      tabs.appendChild(button);
    });
    view.appendChild(tabs);
    const list = document.createElement('div');
    list.id = 'friendHubList';
    list.className = 'friend-hub-list friend-page-list';
    view.appendChild(list);
    renderFriendHub();
  }
  function closeFriendHub() { if (pageViewState.name === 'friends') showFeed(); }

  async function renderFriendHub() {
    const thisLoad = ++hubLoadId;
    const host = document.getElementById('friendHubList');
    const searchInput = document.getElementById('friendSearch');
    if (!host || !searchInput) return;
    host.replaceChildren();
    document.querySelectorAll('.friend-tabs button').forEach(function (button) {
      button.classList.toggle('active', button.dataset.tab === friendTab);
    });
    const query = searchInput.value.trim();
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
        {
          const dm = makeAction('私信', 'follow');
          dm.addEventListener('click', function () { startDmWith(item.user.id); });
          actions.appendChild(dm);
        }
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
        const dmBtn = document.createElement('button');
        dmBtn.type = 'button';
        dmBtn.className = 'dm-btn';
        dmBtn.textContent = '私信';
        dmBtn.addEventListener('click', function () { startDmWith(person.id); });
        row.appendChild(dmBtn);
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
    document.body.classList.add('composer-open');
    setMusicPanel(kind === 'music');
    if (kind === 'photo') document.getElementById('photoInput').click();
    if (kind === 'video') document.getElementById('videoInput').click();
  }
  function setMusicPanel(open) {
    const panel = document.getElementById('musicPanel');
    const button = document.getElementById('musicToggleButton');
    panel.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.textContent = selectedOnlineTrack ? '已选歌曲' : (open ? '收起' : '选择');
    if (open && !document.getElementById('musicResults').childElementCount) searchOnlineMusic(true);
  }
  function closeComposer() {
    document.getElementById('modal').classList.remove('open');
    document.body.classList.remove('composer-open');
    if (activeMusicPreview) activeMusicPreview.pause();
    activeMusicPreview = null;
    if (activeMusicPreviewButton) activeMusicPreviewButton.textContent = '试听';
    activeMusicPreviewButton = null;
    const selectedPlayer = document.querySelector('#audioPreview audio');
    if (selectedPlayer) selectedPlayer.pause();
  }

  function musicAudioUrl(track) {
    const trackId = typeof track === 'object' ? track.id : track;
    const source = typeof track === 'object' ? track.source : '';
    // iTunes：直接播 30 秒试听 previewUrl，不走后端代理。
    if (typeof track === 'object' && track.previewUrl && (source === 'itunes' || !source)) return track.previewUrl;
    if (source === 'itunes') return apiBase + '/api/music/tracks/' + encodeURIComponent(trackId) + '/audio?source=itunes';
    return apiBase + '/api/music/tracks/' + encodeURIComponent(trackId) + '/audio';
  }

  function musicSourceLabel(track) {
    if (!track) return '';
    if (track.source === 'itunes') return 'iTunes · 30秒试听';
    if (track.source === 'jamendo') return 'Jamendo';
    return 'iTunes · 30秒试听';
  }

  function musicPageLabel(track) {
    if (!track) return '曲目页';
    return track.source === 'jamendo' ? 'Jamendo 曲目页' : 'Apple Music 曲目页';
  }

  function showSelectedTrack(track) {
    const preview = document.getElementById('audioPreview');
    preview.hidden = false;
    preview.replaceChildren();
    const name = document.createElement('span');
    name.textContent = '已选网络配乐：' + track.title + ' · ' + track.artist + '（' + musicSourceLabel(track) + '）';
    const player = document.createElement('audio');
    player.controls = true;
    player.preload = 'none';
    player.src = musicAudioUrl(track);
    const credit = document.createElement('small');
    credit.className = 'music-credit';
    credit.append(document.createTextNode('创作者：' + track.artist + ' · ' + musicSourceLabel(track) + ' · 音乐来源：'));
    const source = document.createElement('a');
    source.href = track.pageUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = musicPageLabel(track);
    credit.appendChild(source);
    preview.append(name, player, credit);
  }

  function useOnlineTrack(track) {
    if (activeMusicPreview) activeMusicPreview.pause();
    activeMusicPreview = null;
    if (activeMusicPreviewButton) activeMusicPreviewButton.textContent = '试听';
    activeMusicPreviewButton = null;
    selectedOnlineTrack = track;
    const audioInput = document.getElementById('audioInput');
    audioInput.value = '';
    if (selectedAudioUrl) URL.revokeObjectURL(selectedAudioUrl);
    selectedAudioUrl = '';
    showSelectedTrack(track);
    toast('已选配乐：' + track.title);
  }

  let activeMusicPreview = null;
  let activeMusicPreviewButton = null;
  function previewOnlineTrack(track, button) {
    if (activeMusicPreview && activeMusicPreview.dataset.trackId === String(track.id)) {
      activeMusicPreview.pause();
      if (activeMusicPreviewButton) activeMusicPreviewButton.textContent = '继续试听';
      return;
    }
    if (activeMusicPreview) activeMusicPreview.pause();
    if (activeMusicPreviewButton) activeMusicPreviewButton.textContent = '试听';
    const copy = button.closest('.music-track').querySelector('.music-track-copy');
    let player = copy.querySelector('audio');
    if (!player) {
      player = document.createElement('audio');
      player.controls = true;
      player.preload = 'none';
      player.style.cssText = 'display:block;width:100%;height:38px;margin-top:8px';
      player.src = musicAudioUrl(track);
      player.dataset.trackId = String(track.id);
      copy.appendChild(player);
      player.addEventListener('error', function () {
        if (activeMusicPreview === player) {
          activeMusicPreview = null;
          activeMusicPreviewButton = null;
          button.textContent = '重试';
        }
        toast('歌曲暂时无法播放，请稍后重试或换一首');
      });
      player.addEventListener('ended', function () {
        if (activeMusicPreview === player) {
          activeMusicPreview = null;
          activeMusicPreviewButton = null;
          button.textContent = '试听';
        }
      });
    }
    player.preload = 'none';
    activeMusicPreview = player;
    activeMusicPreviewButton = button;
    button.textContent = '暂停';
    player.play().catch(function () {
      if (activeMusicPreview === player) {
        button.textContent = '点播放器试听';
      }
      // Keep native controls visible so users can start playback manually if
      // Android blocks script-started audio or the connection needs a retry.
    });
  }

  async function searchOnlineMusic(reset) {
    const results = document.getElementById('musicResults');
    const more = document.getElementById('musicMoreButton');
    const button = document.getElementById('musicSearchButton');
    if (reset) {
      musicSearchOffset = 0;
      results.replaceChildren();
      results.textContent = '正在查找音乐…';
    }
    button.disabled = true;
    try {
      const query = document.getElementById('musicSearch').value.trim();
      const params = new URLSearchParams({ q: query, offset: String(musicSearchOffset), source: 'itunes' });
      const result = await request('/api/music/search?' + params.toString());
      if (reset) results.replaceChildren();
      if (!result.tracks.length && !results.childElementCount) {
        const empty = document.createElement('div');
        empty.className = 'music-track-artist';
        empty.style.padding = '14px';
        empty.textContent = '没有找到歌曲，试试中文歌名或歌手名，如 稻香 / 周杰伦。';
        results.appendChild(empty);
      }
      result.tracks.forEach(function (track) {
        const row = document.createElement('div');
        row.className = 'music-track';
        const copy = document.createElement('div');
        copy.className = 'music-track-copy';
        const title = document.createElement('div');
        title.className = 'music-track-title';
        title.textContent = track.title;
        const artist = document.createElement('div');
        artist.className = 'music-track-artist';
        artist.textContent = track.artist + ' · ' + musicSourceLabel(track);
        copy.append(title, artist);
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'icon-label';
        play.textContent = '试听';
        play.addEventListener('click', function () { previewOnlineTrack(track, play); });
        const choose = document.createElement('button');
        choose.type = 'button';
        choose.className = 'choose';
        choose.textContent = '选用';
        choose.addEventListener('click', function () { useOnlineTrack(track); });
        row.append(copy, play, choose);
        results.appendChild(row);
      });
      musicSearchOffset += result.tracks.length;
      more.hidden = !result.hasMore;
    } catch (error) {
      results.replaceChildren();
      const message = document.createElement('div');
      message.className = 'music-track-artist';
      message.style.padding = '14px';
      message.textContent = error.message;
      results.appendChild(message);
      more.hidden = true;
    } finally { button.disabled = false; }
  }

  // 发动态预览：每张图/每个视频右上角都有 ×，点一下只删这一张，不用重选全部。
  function revokePreviewUrls() {
    const preview = document.getElementById('preview');
    if (!preview) return;
    preview.querySelectorAll('img,video').forEach(function (old) {
      if (old.src && old.src.startsWith('blob:')) URL.revokeObjectURL(old.src);
    });
  }
  function renderMediaPreview() {
    const preview = document.getElementById('preview');
    if (!preview) { toast('预览区异常，请重试'); return; }
    revokePreviewUrls();
    preview.replaceChildren();
    if (!selectedMediaFiles.length) {
      preview.style.display = 'none';
      preview.classList.remove('preview-grid');
      return;
    }
    preview.style.display = 'block';
    preview.classList.add('preview-grid');
    selectedMediaFiles.forEach(function (file, index) {
      const item = document.createElement('div');
      item.className = 'preview-item';
      let element;
      const isVideo = file.type.startsWith('video/');
      if (isVideo) { element = document.createElement('video'); element.controls = true; }
      else { element = document.createElement('img'); element.alt = '上传预览'; }
      element.src = URL.createObjectURL(file);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'preview-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', '删除第' + (index + 1) + '个' + (isVideo ? '视频' : '图片'));
      remove.addEventListener('click', function (event) { event.stopPropagation(); removeMediaAt(index); });
      item.append(element, remove);
      preview.appendChild(item);
    });
    const clearRow = document.createElement('div');
    clearRow.className = 'preview-clear-row';
    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'preview-clear';
    clearAll.textContent = '全部清除';
    clearAll.addEventListener('click', function () { clearAllMedia(); });
    clearRow.appendChild(clearAll);
    preview.appendChild(clearRow);
  }
  function removeMediaAt(index) {
    if (index < 0 || index >= selectedMediaFiles.length) return;
    selectedMediaFiles.splice(index, 1);
    const photoInput = document.getElementById('photoInput');
    const videoInput = document.getElementById('videoInput');
    if (photoInput) photoInput.value = '';
    if (videoInput) videoInput.value = '';
    renderMediaPreview();
    toast('已删除这张，剩 ' + selectedMediaFiles.length + ' 张');
  }
  function clearAllMedia() {
    selectedMediaFiles = [];
    const photoInput = document.getElementById('photoInput');
    const videoInput = document.getElementById('videoInput');
    if (photoInput) photoInput.value = '';
    if (videoInput) videoInput.value = '';
    renderMediaPreview();
    toast('已清空已选媒体');
  }

  function loadMedia(input) {
    const files = Array.from(input.files || []).slice(0, 9);
    if (!files.length) { toast('未选择到文件，请重试'); return; }
    if (files.some(function (f) { return f.type === 'image/heic' || f.type === 'image/heif'; })) toast('HEIC 照片可能无法预览，但仍可上传，服务器会原样保存。');
    const oversize = files.find(function (f) { return f.size > 50 * 1024 * 1024; });
    if (oversize) { toast('照片或视频不能超过 50 MB'); input.value = ''; return; }
    const merged = selectedMediaFiles.concat(files).slice(0, 9);
    if (merged.length >= 9 && selectedMediaFiles.length + files.length > 9) toast('最多一次传 9 个媒体');
    selectedMediaFiles = merged;
    // 清空 input，下次选同一张图也能再次触发 change。
    input.value = '';
    renderMediaPreview();
  }

  function loadAudio(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast('配乐文件不能超过 20 MB'); input.value = ''; return; }
    selectedOnlineTrack = null;
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

  // 发布前压缩图片：最长边最大 1600px，JPEG 质量 0.82。视频/音频不压缩。
  // 任何一步失败都回退到原图上传，绝不让压缩导致发布失败。GIF 不压缩（保留动图）。
  // HEIC/HEIF 在部分 WebView 里 createImageBitmap 解码失败，走 catch 回退原图上传，不会因此发不出去。
  async function compressImageFile(file) {
    try {
      if (!file || !file.type?.startsWith('image/') || file.type === 'image/gif') return file;
      const bitmap = await createImageBitmap(file);
      try {
        const maxSide = Math.max(bitmap.width, bitmap.height);
        const scale = Math.min(1, 1600 / maxSide);
        if (scale >= 1) return file;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
        if (!blob) return file;
        const name = file.name.replace(/\.[^.]*$/, '') + '.jpg';
        return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
      } finally {
        if (bitmap.close) bitmap.close();
      }
    } catch {
      return file;
    }
  }

  async function publishPost() {
    if (!me) return showAuth();
    const caption = document.getElementById('caption');
    const mediaFiles = selectedMediaFiles.length ? selectedMediaFiles : Array.from(document.getElementById('photoInput').files || []).concat(Array.from(document.getElementById('videoInput').files || [])).slice(0, 9);
    const audioFile = document.getElementById('audioInput').files?.[0];
    if (!caption.value.trim() && !mediaFiles.length && !audioFile && !selectedOnlineTrack) { toast('写点文字或添加照片、视频、配乐吧'); return; }
    const visibilityEl = document.getElementById('visibilitySelect');
    const categoryEl = document.getElementById('categorySelect');
    const form = new FormData();
    form.append('text', caption.value.trim());
    form.append('visibility', visibilityEl ? visibilityEl.value : 'friends');
    form.append('category', categoryEl ? categoryEl.value : '日常');
    form.append('music', selectedOnlineTrack ? selectedOnlineTrack.title : '');
    form.append('musicArtist', selectedOnlineTrack ? selectedOnlineTrack.artist : '');
    form.append('musicTrackId', selectedOnlineTrack ? String(selectedOnlineTrack.id) : '');
    form.append('musicSource', selectedOnlineTrack ? (selectedOnlineTrack.source || 'itunes') : '');
    form.append('musicPreviewUrl', selectedOnlineTrack ? (selectedOnlineTrack.previewUrl || '') : '');
    form.append('musicPageUrl', selectedOnlineTrack ? (selectedOnlineTrack.pageUrl || '') : '');
    for (const file of mediaFiles) {
      const uploadMedia = file.type?.startsWith('image/') ? await compressImageFile(file) : file;
      form.append('media', uploadMedia, uploadMedia.name);
    }
    if (audioFile) form.append('audio', audioFile, audioFile.name);
    const button = document.querySelector('#modal .publish');
    button.disabled = true;
    button.textContent = '正在发布…';
    try {
      await request('/api/posts', { method: 'POST', body: form });
      caption.value = '';
      selectedMediaFiles = [];
      revokePreviewUrls();
      document.getElementById('preview').replaceChildren();
      document.getElementById('preview').style.display = 'none';
      document.getElementById('preview').classList.remove('preview-grid');
      document.getElementById('photoInput').value = '';
      document.getElementById('videoInput').value = '';
      document.getElementById('audioInput').value = '';
      document.getElementById('audioPreview').replaceChildren();
      document.getElementById('audioPreview').hidden = true;
      if (selectedAudioUrl) URL.revokeObjectURL(selectedAudioUrl);
      selectedAudioUrl = '';
      selectedOnlineTrack = null;
      document.getElementById('musicSearch').value = '';
      document.getElementById('musicResults').replaceChildren();
      document.getElementById('musicMoreButton').hidden = true;
      musicSearchOffset = 0;
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
      document.querySelectorAll('[data-post-id="' + CSS.escape(id) + '"]').forEach(function (post) { post.remove(); });
      closeDeleteDialog();
      await loadFeed();
      await loadProfileCounts();
      if (pageViewState.name === 'profile' && pageViewState.userId) await openUserProfile(pageViewState.userId);
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
    installProfilePage();
    installDmUI();
    var dmNavBtn = document.querySelector('.mobile-nav button[aria-label="消息"]');
    if (dmNavBtn && !dmNavBtn.querySelector('.dm-badge')) {
      var dmBadge = document.createElement('span');
      dmBadge.className = 'dm-badge';
      dmNavBtn.appendChild(dmBadge);
    }
    const date = document.getElementById('today');
    if (date) date.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
    document.getElementById('photoInput').addEventListener('change', function (event) { loadMedia(event.target); });
    document.getElementById('videoInput').addEventListener('change', function (event) { loadMedia(event.target); });
    document.getElementById('audioInput').addEventListener('change', function (event) { loadAudio(event.target); });
    document.getElementById('musicSearchButton').addEventListener('click', function () { searchOnlineMusic(true); });
    document.getElementById('musicToggleButton').addEventListener('click', function () {
      setMusicPanel(document.getElementById('musicPanel').hidden);
    });
    document.getElementById('musicRecommendButton').addEventListener('click', function () {
      document.getElementById('musicSearch').value = '';
      searchOnlineMusic(true);
    });
    document.getElementById('musicMoreButton').addEventListener('click', function () { searchOnlineMusic(false); });
    document.getElementById('musicSearch').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); searchOnlineMusic(true); }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeComposer(); closeFriendHub(); closeDeleteDialog(); closeMyProfile(); closeDmList(); closeDmChat(); }
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
  window.openDmList = openDmList;
  window.closeDmList = closeDmList;
  window.closeDmChat = closeDmChat;
  window.startDmWith = startDmWith;
  window.openMyProfile = openMyProfile;
  window.closeMyProfile = closeMyProfile;
  window.openUserProfile = openUserProfile;
  window.showFeed = showFeed;
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

