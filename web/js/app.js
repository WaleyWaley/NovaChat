/**
 * NovaChat Web — 主应用逻辑 (Telegram-style UI)
 */

// ===== 状态管理 =====
const State = {
  me: null,              // { user_id, username, first_name }
  chats: new Map(),      // peer_id → { messages: [], peerName: '' }
  activePeerId: null,
  userNames: new Map(JSON.parse(localStorage.getItem('nc_names') || '[]')),  // 持久化
};

// ===== DOM 引用 =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const authScreen = $('#auth-screen');
const chatScreen = $('#chat-screen');
const loginForm = $('#login-form');
const registerForm = $('#register-form');
const loginError = $('#login-error');
const registerError = $('#register-error');
const chatList = $('#chat-list');
const chatMain = $('#chat-main');
const myUsername = $('#my-username');
const myAvatar = $('#my-avatar');

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  API.init('');

  // 检查已登录状态 (静默连接, 失败不提示)
  const saved = localStorage.getItem('novachat_user');
  if (saved) {
    try {
      const user = JSON.parse(saved);
      API._token = user.access_token;
      doConnect(user.access_token, user).catch(() => {
        // token 过期, 清除并显示登录页
        localStorage.removeItem('novachat_user');
        API._token = null;
      });
    } catch { /* stale */ }
  }

  setupAuthUI();
  setupChatUI();
});

// ===== 登录/注册 UI =====
function setupAuthUI() {
  // Tab 切换
  $$('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.auth-form').forEach(f => f.classList.remove('active'));
      $(`#${tab.dataset.tab}-form`).classList.add('active');
    });
  });

  // 登录
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    API._token = null;  // 清除旧 token, 登录不需要鉴权
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;

    try {
      const result = await API.login(username, password);
      if (result.error_code && result.error_code !== 0) {
        showToast('❌ ' + (result.error_message || 'Login failed'), 'error');
        loginError.textContent = result.error_message || 'Login failed';
        return;
      }
      // 登录返回已包含用户资料, 直接用
      showToast('✅ Welcome!', 'success');
      const accessToken = result.access_token;
      API._token = accessToken;
      showToast('✅ Account created! Logging in...', 'success');
      const user = {
        user_id: result.user?.user_id || 0,
        username: username,
        first_name: result.user?.first_name || username,
        access_token: accessToken,
      };
      localStorage.setItem('novachat_user', JSON.stringify(user));
      doConnect(accessToken, user);
    } catch (err) {
      loginError.textContent = `Connection error: ${err.message}`;
    }
  });

  // 注册
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    registerError.textContent = '';
    API._token = null;  // 清除旧 token, 注册不需要鉴权
    const username = $('#reg-username').value.trim();
    const firstName = $('#reg-firstname').value.trim();
    const lastName = $('#reg-lastname').value.trim();
    const password = $('#reg-password').value;

    if (!firstName) { registerError.textContent = 'First name is required'; return; }

    try {
      const result = await API.register(username, password, firstName, lastName);
      if (result.error_code && result.error_code !== 0) {
        showToast('❌ ' + (result.error_message || 'Registration failed'), 'error');
        registerError.textContent = result.error_message || 'Registration failed';
        return;
      }
      showToast('✅ Account created! Logging in...', 'success');
      const user = {
        user_id: result.user_id,
        username: username,
        first_name: firstName,
        access_token: result.access_token,
        refresh_token: result.refresh_token,
      };
      API._token = user.access_token;
      localStorage.setItem('novachat_user', JSON.stringify(user));
      doConnect(user.access_token, user);
    } catch (err) {
      registerError.textContent = `Connection error: ${err.message}`;
    }
  });
}

// ===== WebSocket 连接 =====
async function doConnect(token, user) {
  try {
    const payload = await API.connect(token);
    State.me = { ...user, ...payload };
    showChatScreen();
    API.startPing();
    setupMessageHandler();
  } catch (err) {
    console.error('WebSocket connection failed:', err);
    loginError.textContent = 'Cannot connect to server. Is the gateway running?';
  }
}

function setupMessageHandler() {
  API.onMessage((payload) => {
    if (payload.rpc_result) {
      const p = payload.rpc_result;
      addSentConfirmation(p.seq || 0, p.data?.message_id);
    } else if (payload.update_type === 0 || payload.update_type === 'UPDATE_NEW_MESSAGE' || payload.update_type === '0') {
      const msg = payload.data;
      if (msg) receiveMessage(msg);
    } else if (payload.call_signal) {
      handleIncomingCallSignal(payload.call_signal);
    } else if (payload.room_signal) {
      handleRoomSignal(payload.room_signal);
    }
  });
}

function showChatScreen() {
  authScreen.style.display = 'none';
  chatScreen.style.display = 'flex';
  myUsername.textContent = State.me.first_name || State.me.username;
  const myName = State.me.first_name || State.me.username;
  myAvatar.textContent = myName[0].toUpperCase();
  myAvatar.style.background = avatarColor(myName);
}

// ===== 聊天 UI =====
function setupChatUI() {
  $('#logout-btn').addEventListener('click', logout);
  $('#menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    let menu = document.getElementById('nova-menu');
    if (menu) { menu.remove(); return; }
    menu = document.createElement('div'); menu.id = 'nova-menu';
    menu.style.cssText = 'position:absolute;top:50px;left:10px;width:260px;background:var(--bg-primary);border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.6);z-index:10000;border:1px solid var(--border);padding:16px;';
    menu.innerHTML = `
      <div style="font-size:16px;font-weight:700;margin-bottom:12px;">✧ NovaChat</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:14px;">v0.3 — Phase 4 Complete</div>
      <div style="font-size:13px;line-height:2;">
        <div>💬 <b>Messaging</b> — Real-time chat + Push</div>
        <div>📞 <b>1v1 Calls</b> — WebRTC P2P Audio</div>
        <div>🔊 <b>Group Voice</b> — Mesh Multi-peer</div>
        <div>🔐 <b>Auth</b> — JWT + PBKDF2</div>
        <div>🗄️ <b>Storage</b> — MySQL + Redis</div>
        <div>🐳 <b>Deploy</b> — Docker Compose</div>
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--text-muted);">
        C++ bRPC + TypeScript Gateway + WebRTC
      </div>`;
    document.querySelector('.sidebar').appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
  });
  $('#new-chat-btn').addEventListener('click', () => {
    const searchInput = $('#search-input');
    searchInput.focus();
    searchInput.value = '';
    searchInput.placeholder = 'Search username to start chat...';
  });
  $('#search-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const query = e.target.value.trim();
      if (!query) return;
      try {
        const result = await API.searchUsers(query);
        if (result.users) {
          renderSearchResults(result.users);
        }
      } catch (err) {
        console.error('Search failed:', err);
      }
    }
  });
  $('#new-chat-btn').addEventListener('click', () => {
    $('#search-input').focus();
  });
}

function renderSearchResults(users) {
  chatList.innerHTML = '';
  for (const u of users) {
    if (String(u.user_id) === String(State.me.user_id)) continue;
    State.userNames.set(String(u.user_id), u.first_name || u.username);
    localStorage.setItem('nc_names', JSON.stringify([...State.userNames]));
    const item = createChatItem(u);
    chatList.appendChild(item);
  }
  // 如果没有结果, 显示提示
  if (chatList.children.length === 0) {
    chatList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">No users found</div>';
  }
}

function createChatItem(user) {
  const div = document.createElement('div');
  div.className = 'chat-item';
  const pid = String(user.user_id || user.id || '');
  div.dataset.peerId = pid;
  div.dataset.peerName = user.first_name || user.username || 'Unknown';

  const initial = (user.first_name || user.username)[0].toUpperCase();
  const name = user.first_name || user.username || 'User';
  const color = avatarColor(name);
  div.innerHTML = `
    <div class="chat-item-avatar" style="background:${color}">${name[0].toUpperCase()}</div>
    <div class="chat-item-content">
      <div class="chat-item-name">${name}</div>
      <div class="chat-item-preview">@${user.username || 'unknown'}</div>
    </div>
    <div class="chat-item-meta"><span class="chat-item-time"></span></div>
  `;

  div.addEventListener('click', () => {
    // 如果在房间中, 点击用户直接邀请
    if (roomState.roomId) {
      API.sendRoomSignal('invite', { room_id: roomState.roomId, invite_user_ids: [pid] });
      showToast(`📨 Invited ${user.first_name || user.username} to room`, 'info');
      return;
    }
    openChat(pid, user.first_name || user.username);
    $$('.chat-item').forEach(c => c.classList.remove('active'));
    div.classList.add('active');
  });

  return div;
}

// ===== 打开聊天窗口 =====
function openChat(peerId, peerName) {
  const pid = String(peerId);
  State.activePeerId = pid;
  State.userNames.set(pid, peerName);
  localStorage.setItem('nc_names', JSON.stringify([...State.userNames]));

  // 清零未读
  const openedChat = State.chats.get(pid);
  if (openedChat) { openedChat.unread = 0; updateUnreadBadge(pid, 0); }

  if (!State.chats.has(pid)) {
    State.chats.set(pid, { messages: [], peerName });
  }

  // 隐藏 placeholder
  chatMain.querySelector('.chat-placeholder')?.remove();

  // 移除旧窗口
  chatMain.querySelector('.chat-window')?.remove();

  // 创建新窗口
  const tmpl = $('#chat-window-template').content.cloneNode(true);
  const win = tmpl.querySelector('.chat-window');
  const color = avatarColor(peerName);
  win.querySelector('.peer-name').textContent = peerName;
  win.querySelector('.peer-avatar').textContent = peerName[0].toUpperCase();
  win.querySelector('.peer-avatar').style.background = color;

  // 返回按钮
  win.querySelector('.back-btn').addEventListener('click', () => {
    chatMain.classList.remove('active');
  });

  // 发送按钮
  const input = win.querySelector('.chat-input');
  const sendBtn = win.querySelector('.send-btn');
  const msgContainer = win.querySelector('.chat-messages');

  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    const seq = API.sendMessage(peerId, text);
    // 乐观渲染 + 存入 State
    const tempId = 'temp_' + seq;
    const msgObj = { message_id: tempId, from_peer: { id: String(State.me.user_id) }, text, created_at: Date.now(), is_me: true, status: 'sending' };
    const el = addMessage(msgContainer, msgObj);
    pendingMessages.set(seq, el);
    // 也存入 State, 下次打开对话时能恢复
    let chat = State.chats.get(String(peerId));
    if (!chat) { chat = { messages: [], peerName }; State.chats.set(String(peerId), chat); }
    chat.messages.push(msgObj);
    input.value = '';
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // 渲染已有消息
  const chat = State.chats.get(peerId);
  for (const msg of chat.messages) {
    addMessage(msgContainer, msg);
  }

  chatMain.appendChild(win);
  setupCallButton(win, String(peerId));
  input.focus();
  msgContainer.scrollTop = msgContainer.scrollHeight;

  // 响应式: 移动端显示聊天窗口
  chatMain.classList.add('active');
  $('.sidebar')?.classList.add('hidden');
  win.querySelector('.back-btn').addEventListener('click', () => {
    chatMain.classList.remove('active');
    const sidebar = $('.sidebar');
    if (sidebar) sidebar.classList.remove('hidden');
  });
}

// ===== 消息渲染 =====
function addMessage(container, msg) {
  const existing = container.querySelector(`[data-msg-id="${msg.message_id}"]`);
  if (existing) return;

  const isMe = msg.is_me || (msg.from_peer && String(msg.from_peer.id) === String(State.me?.user_id));
  const div = document.createElement('div');
  div.className = `message ${isMe ? 'me' : 'you'}`;
  div.dataset.msgId = msg.message_id;
  const timeStr = formatTime(msg.created_at || Date.now());
  div.innerHTML = `
    <div class="message-text">${escapeHtml(msg.text)}</div>
    <div class="msg-time">${timeStr}${isMe ? ` <span class="message-status">${msg.status === 'sending' ? '⋯' : msg.status === 'sent' ? '✓' : '✓✓'}</span>` : ''}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

// seq → 临时消息 DOM 元素 映射
const pendingMessages = new Map();

function addSentConfirmation(seq, realMsgId) {
  const temp = pendingMessages.get(seq);
  if (temp) {
    pendingMessages.delete(seq);
    const newId = String(realMsgId || ('sent_' + seq));
    temp.dataset.msgId = newId;
    const status = temp.querySelector('.message-status');
    if (status) status.textContent = '✓';
    // 同步更新 State 中的 message_id
    const tempId = 'temp_' + seq;
    for (const [, chat] of State.chats) {
      const msg = chat.messages.find(m => String(m.message_id) === tempId);
      if (msg) { msg.message_id = newId; msg.status = 'sent'; break; }
    }
  }
}

function receiveMessage(msg) {
  const inner = msg.newMessage || msg.new_message || msg;
  if (!inner || !inner.text) { return; }

  const fromId = String(inner.fromPeer?.id || inner.from_peer?.id || '0');
  const text = inner.text || '';
  const msgId = String(inner.messageId || inner.message_id || Date.now());

  // 自己的消息忽略
  if (String(State.me?.user_id) === fromId) return;

  // 获取或创建对话
  let peerName = State.userNames.get(fromId) || ('User ' + fromId.slice(-6));
  let chat = State.chats.get(fromId);
  if (!chat) {
    chat = { messages: [], peerName, unread: 0 };
    State.chats.set(fromId, chat);
    chatList.querySelector('.no-users')?.remove();
    const item = createChatItem({ user_id: fromId, first_name: peerName, username: peerName });
    chatList.insertBefore(item, chatList.firstChild);
  }

  // 未读计数: 如果当前不在看这个对话, 增加未读数
  if (String(State.activePeerId) !== fromId) {
    chat.unread = (chat.unread || 0) + 1;
    updateUnreadBadge(fromId, chat.unread);
  }
  // 异步查真实用户名 (直连 user-service, 不走网关)
  if (!State.userNames.has(fromId)) {
    const uid = fromId;
    setTimeout(async () => {
      try {
        const res = await fetch('/api/user/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (API._token || '') },
          body: JSON.stringify({ user_id: Number(uid) }),
        });
        const p = await res.json();
        if (p && p.user && p.user.username) {
          const name = p.user.first_name || p.user.username;
          State.userNames.set(fromId, name);
          localStorage.setItem('nc_names', JSON.stringify([...State.userNames]));
          updatePeerNames(fromId, name);
          console.log('Name resolved:', uid, '→', name);
        }
      } catch(e) { console.log('Name lookup failed:', uid, e.message); }
    }, 50);
  }
  // 去重并添加消息
  if (!chat.messages.some(m => String(m.message_id) === msgId)) {
    chat.messages.push({ message_id: msgId, from_peer: { id: fromId }, text, created_at: Date.now(), is_me: false });
  }

  // 如果当前正在看这个对话, 实时渲染
  if (String(State.activePeerId) === fromId) {
    const container = chatMain.querySelector('.chat-messages');
    if (container) {
      addMessage(container, { message_id: msgId, from_peer: { id: fromId }, text, is_me: false });
    }
  }
}

function updateUnreadBadge(peerId, count) {
  const items = document.querySelectorAll('.chat-item');
  for (const item of items) {
    if (item.dataset.peerId === peerId) {
      let badge = item.querySelector('.chat-item-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'chat-item-badge';
          item.querySelector('.chat-item-meta').appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'flex';
      } else if (badge) {
        badge.style.display = 'none';
      }
      return;
    }
  }
}

function updatePeerNames(userId, name) {
  // 更新聊天列表中的名字
  document.querySelectorAll('.chat-item').forEach(item => {
    if (item.dataset.peerId === userId) {
      item.querySelector('.chat-item-name').textContent = name;
      item.dataset.peerName = name;
    }
  });
  // 更新聊天窗口标题
  const win = document.querySelector('.chat-window');
  if (win && State.activePeerId === userId) {
    win.querySelector('.peer-name').textContent = name;
    win.querySelector('.peer-avatar').textContent = name[0].toUpperCase();
  }
  // 更新缓存
  const chat = State.chats.get(userId);
  if (chat) chat.peerName = name;
}

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  const bg = type === 'success' ? '#4caf50' : type === 'error' ? '#e74c3c' : 'var(--accent)';
  el.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:12px 28px;border-radius:12px;font-size:14px;font-weight:600;z-index:99999;animation:toastIn 0.3s ease;box-shadow:0 4px 20px rgba(0,0,0,0.4);`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, 2000);
  setTimeout(() => el.remove(), 2500);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== 登出 =====
// ===== Phase 4: WebRTC 1-on-1 Call =====
// ===== 头像颜色 =====
const AVATAR_COLORS = ['#2ea6ff','#e74c3c','#f39c12','#2ecc71','#9b59b6','#1abc9c','#e67e22','#3498db'];
function avatarColor(name) { let h=0; for(let i=0;i<(name||'').length;i++) h+=name.charCodeAt(i); return AVATAR_COLORS[h%AVATAR_COLORS.length]; }
function formatTime(ts) { const d=new Date(ts); return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0'); }

let localStream = null;
let peerConnection = null;
let currentCallPeerId = null;

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function setupCallButton(win, peerId) {
  const callBtn = win.querySelector('.call-btn');
  if (!callBtn) return;
  callBtn.onclick = async () => {
    if (peerConnection) { hangUp(); return; }
    currentCallPeerId = String(peerId);
    try {
      console.log('Requesting microphone...');
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      console.log('Microphone OK, starting call...');
      startCall();
    } catch (err) {
      alert('Microphone access denied: ' + err.message);
    }
  };
}

async function startCall() {
  peerConnection = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) API.sendCallSignal('ice_candidate', currentCallPeerId, { candidate: e.candidate });
  };

  peerConnection.ontrack = (e) => {
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  console.log('Sending call_start to', currentCallPeerId);
  API.sendCallSignal('call_start', currentCallPeerId, { sdp: offer });
  showCallScreen(State.chats.get(currentCallPeerId)?.peerName || 'User', false);
}

async function handleIncomingCallSignal(sig) {
  const { signal_type, from_user_id, from_username, data } = sig;
  if (signal_type === 'call_start' && !peerConnection) {
    currentCallPeerId = String(from_user_id);
    showCallScreen(from_username || 'User', true);
    // 用自定义按钮代替 confirm
    const hangupBtn = document.getElementById('call-hangup-btn');
    const statusEl = document.getElementById('call-screen-status');
    // 替换为接听/拒绝双按钮
    const btnDiv = hangupBtn?.parentElement;
    if (btnDiv) {
      btnDiv.innerHTML = `
        <button id="call-accept-btn" style="width:60px;height:60px;border-radius:50%;border:none;background:#4caf50;color:#fff;font-size:24px;cursor:pointer;">📞</button>
        <button id="call-reject-btn" style="width:60px;height:60px;border-radius:50%;border:none;background:#e74c3c;color:#fff;font-size:24px;cursor:pointer;">✕</button>`;
      document.getElementById('call-accept-btn').onclick = () => {
        // 恢复为挂断按钮
        btnDiv.innerHTML = '<button id="call-hangup-btn" style="width:60px;height:60px;border-radius:50%;border:none;background:#e74c3c;color:#fff;font-size:24px;cursor:pointer;">✕</button>';
        document.getElementById('call-hangup-btn').onclick = () => hangUp();
        acceptCall(from_user_id, data);
      };
      document.getElementById('call-reject-btn').onclick = () => {
        API.sendCallSignal('call_end', from_user_id, {});
        hideCallScreen();
        currentCallPeerId = null;
      };
    }
    return;
  }
  // call_start 接受后处理
  if (signal_type === 'call_answer_accept' && !peerConnection) {
    const peerId = from_user_id;
    const sdp = data?.sdp;
    if (!sdp) return;
    (async () => {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        peerConnection = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
        peerConnection.onicecandidate = (e) => { if (e.candidate) API.sendCallSignal('ice_candidate', peerId, { candidate: e.candidate }); };
        peerConnection.ontrack = (e) => { const a = new Audio(); a.srcObject = e.streams[0]; a.play().catch(()=>{}); };
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        API.sendCallSignal('answer', peerId, { sdp: answer });
        updateCallConnected(State.chats.get(currentCallPeerId || peerId)?.peerName || 'User');
      } catch(e) { console.error(e); hangUp(); }
    })();
    return;
  }
  if (signal_type === 'call_start' && peerConnection) { return; }
  // 以下处理 answer / ice / call_end
  if (signal_type === 'answer' && peerConnection) {
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp)).catch(()=>{});
    updateCallConnected(State.chats.get(currentCallPeerId || peerId)?.peerName || 'User');
  } else if (signal_type === 'ice_candidate' && peerConnection && data?.candidate) {
    peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(()=>{});
  } else if (signal_type === 'call_end') {
    hangUp();
  }
}


async function acceptCall(peerId, data) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    peerConnection = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    peerConnection.onicecandidate = (e) => { if (e.candidate) API.sendCallSignal('ice_candidate', peerId, { candidate: e.candidate }); };
    peerConnection.ontrack = (e) => { const a = new Audio(); a.srcObject = e.streams[0]; a.play().catch(()=>{}); };
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    API.sendCallSignal('answer', peerId, { sdp: answer });
    updateCallConnected(State.chats.get(currentCallPeerId || peerId)?.peerName || 'User');
  } catch(e) { console.error(e); hangUp(); }
}

function hangUp() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (currentCallPeerId) { API.sendCallSignal('call_end', currentCallPeerId, {}); currentCallPeerId = null; }
  hideCallScreen();
}

function showCallStatus(msg) {
  // 不再使用浮动小标签, 改用全屏通话界面
}

// ===== 通话界面 =====
let callTimer = null;
let callSeconds = 0;

function showCallScreen(peerName, isIncoming) {
  let el = document.getElementById('call-screen-overlay');
  if (!el) {
    el = document.createElement('div'); el.id = 'call-screen-overlay';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;';
    document.body.appendChild(el);
  }
  const color = avatarColor(peerName);
  el.innerHTML = `
    <div style="width:100px;height:100px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:700;color:#fff;">${peerName[0].toUpperCase()}</div>
    <div style="font-size:22px;font-weight:600;" id="call-screen-name">${escapeHtml(peerName)}</div>
    <div style="font-size:15px;color:var(--text-secondary);" id="call-screen-status">${isIncoming ? 'Incoming call...' : '📞 Calling...'}</div>
    <div style="font-size:13px;color:var(--text-muted);" id="call-screen-time"></div>
    <div style="display:flex;gap:24px;margin-top:12px;">
      <button id="call-hangup-btn" style="width:60px;height:60px;border-radius:50%;border:none;background:#e74c3c;color:#fff;font-size:24px;cursor:pointer;">✕</button>
    </div>`;
  el.style.display = 'flex';
  el.querySelector('#call-hangup-btn').onclick = () => hangUp();
  startCallTimer();
}

function updateCallConnected(peerName) {
  const status = document.getElementById('call-screen-status');
  if (status) status.textContent = '🔊 Connected';
}

function startCallTimer() {
  callSeconds = 0;
  if (callTimer) clearInterval(callTimer);
  const timeEl = document.getElementById('call-screen-time');
  callTimer = setInterval(() => {
    callSeconds++;
    const m = Math.floor(callSeconds / 60);
    const s = callSeconds % 60;
    if (timeEl) timeEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);
}

function hideCallScreen() {
  const el = document.getElementById('call-screen-overlay');
  if (el) el.style.display = 'none';
  if (callTimer) { clearInterval(callTimer); callTimer = null; }
}

// ===== Phase 4.1: Room (Mesh 多人通话) =====
let roomState = { roomId: null, participants: [], peerConns: new Map() }; // userId → RTCPeerConnection

$('#create-room-btn').addEventListener('click', () => {
  if (roomState.roomId) { leaveRoom(); return; }
  API.sendRoomSignal('create');
  showRoomPanel('Creating room...');
});

function handleRoomSignal(sig) {
  const { action, room_id, from_user_id, from_username, participants, webrtc } = sig;
  if (action === 'created' || action === 'joined') {
    roomState.roomId = room_id;
    roomState.participants = participants || [];
    $('#create-room-btn').textContent = '✕';
    showRoomPanel();
    if (action === 'joined' && participants) {
      for (const p of participants) {
        if (String(p.userId) === String(State.me?.user_id)) continue;
        createPeerForRoom(String(p.userId), p.username, true);
      }
    }
  } else if (action === 'user_joined') {
    roomState.participants = participants || roomState.participants;
    if (from_user_id && String(from_user_id) !== String(State.me?.user_id)) {
      createPeerForRoom(String(from_user_id), from_username || 'User', false);
    }
    showRoomPanel();
  } else if (action === 'user_left') {
    roomState.participants = participants || roomState.participants;
    if (from_user_id) closePeer(String(from_user_id));
    showRoomPanel();
    if (roomState.participants.length <= 1 && roomState.participants[0]?.userId === String(State.me?.user_id)) {
      leaveRoom();
    }
  } else if (action === 'webrtc' && webrtc) {
    handleRoomWebRTC(webrtc);
  } else if (action === 'invited') {
    showRoomInvite(from_username || 'User', room_id);
  }
}

// ===== Room Panel (微信群风格) =====
let roomTimerInterval = null;
let roomStartTime = 0;

function showRoomPanel() {
  let el = document.getElementById('room-panel');
  if (!el) {
    el = document.createElement('div'); el.id = 'room-panel';
    el.style.cssText = 'position:fixed;bottom:80px;right:20px;width:280px;background:var(--bg-primary);border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.5);z-index:9999;border:1px solid var(--border);overflow:hidden;';
    // 一次性创建结构, 之后只更新动态内容
    el.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:600;">🔊 Voice Room</span>
        <span id="room-timer" style="font-size:13px;color:var(--text-secondary);">00:00</span>
      </div>
      <div id="room-participants" style="padding:8px 16px;max-height:200px;overflow-y:auto;"></div>
      <div style="padding:12px 16px;display:flex;gap:10px;justify-content:center;border-top:1px solid var(--border);">
        <button id="room-invite-btn" style="padding:8px 14px;border-radius:20px;border:none;background:var(--accent);color:#fff;font-size:13px;cursor:pointer;">+ Invite</button>
        <button id="room-leave-btn" style="padding:8px 14px;border-radius:20px;border:none;background:var(--danger);color:#fff;font-size:13px;cursor:pointer;">Leave</button>
      </div>`;
    document.body.appendChild(el);
    // 绑定事件 (只绑一次)
    el.querySelector('#room-leave-btn').addEventListener('click', () => leaveRoom());
    el.querySelector('#room-invite-btn').addEventListener('click', () => { $('#search-input').focus(); showToast('Search & click user to invite', 'info'); });
  }
  if (!roomStartTime) roomStartTime = Date.now();
  startRoomTimer();
  renderRoomPanel();
}

function renderRoomPanel() {
  const listEl = document.getElementById('room-participants');
  if (!listEl || !roomState.roomId) return;
  listEl.innerHTML = roomState.participants.map(p => {
    const isMe = String(p.userId) === String(State.me?.user_id);
    const cached = State.userNames.get(String(p.userId));
    const displayName = isMe ? (State.me?.first_name || State.me?.username || 'You') : (cached || p.username || ('User ' + String(p.userId).slice(-6)));
    const color = avatarColor(displayName);
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;">
      <div style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0;">${displayName[0].toUpperCase()}</div>
      <span style="font-size:14px;">${escapeHtml(displayName)}${isMe?' (You)':''}</span>
    </div>`;
  }).join('');
}

function showRoomInvite(fromName, roomId) {
  let el = document.getElementById('room-invite');
  if (!el) { el = document.createElement('div'); el.id = 'room-invite'; el.className = 'call-overlay'; document.body.appendChild(el); }
  el.innerHTML = `<div style="font-size:22px;font-weight:600;">🔊 ${escapeHtml(fromName)}</div><div style="font-size:15px;color:var(--text-secondary);">Invites you to a voice room</div><div class="call-btns"><button class="call-accept" id="room-accept">Join</button><button class="call-reject" id="room-reject">Decline</button></div>`;
  el.style.display = 'flex';
  document.getElementById('room-accept').onclick = () => { el.style.display = 'none'; API.sendRoomSignal('join', { room_id: roomId }); };
  document.getElementById('room-reject').onclick = () => { el.style.display = 'none'; };
}

function startRoomTimer() {
  if (roomTimerInterval) return;
  roomTimerInterval = setInterval(() => {
    const el = document.getElementById('room-timer');
    if (!el || !roomState.roomId) { clearInterval(roomTimerInterval); roomTimerInterval = null; return; }
    const sec = Math.floor((Date.now() - roomStartTime) / 1000);
    el.textContent = `${Math.floor(sec/60)}:${(sec%60).toString().padStart(2,'0')}`;
  }, 1000);
}

async function createPeerForRoom(peerId, peerName, createOffer) {
  if (roomState.peerConns.has(peerId)) return;
  let stream = localStream;
  if (!stream) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream = stream; } catch(e) { console.error(e); return; }
  }
  const pc = new RTCPeerConnection(rtcConfig);
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  pc.onicecandidate = (e) => {
    if (e.candidate) API.sendRoomSignal('webrtc', { room_id: roomState.roomId, webrtc: { signal_type: 'ice_candidate', to_user_id: peerId, data: { candidate: e.candidate } } });
  };
  pc.ontrack = (e) => {
    const a = new Audio(); a.srcObject = e.streams[0]; a.play().catch(()=>{});
  };
  roomState.peerConns.set(peerId, pc);
  if (createOffer) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    API.sendRoomSignal('webrtc', { room_id: roomState.roomId, webrtc: { signal_type: 'offer', to_user_id: peerId, data: { sdp: offer } } });
  }
}

async function handleRoomWebRTC(w) {
  const peerId = String(w.from_user_id);
  if (w.signal_type === 'offer') {
    let pc = roomState.peerConns.get(peerId);
    if (!pc) {
      pc = new RTCPeerConnection(rtcConfig);
      if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      pc.onicecandidate = (e) => {
        if (e.candidate) API.sendRoomSignal('webrtc', { room_id: roomState.roomId, webrtc: { signal_type: 'ice_candidate', to_user_id: peerId, data: { candidate: e.candidate } } });
      };
      pc.ontrack = (e) => { const a = new Audio(); a.srcObject = e.streams[0]; a.play().catch(()=>{}); };
      roomState.peerConns.set(peerId, pc);
    }
    await pc.setRemoteDescription(new RTCSessionDescription(w.data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    API.sendRoomSignal('webrtc', { room_id: roomState.roomId, webrtc: { signal_type: 'answer', to_user_id: peerId, data: { sdp: answer } } });
  } else if (w.signal_type === 'answer') {
    const pc = roomState.peerConns.get(peerId);
    if (pc) pc.setRemoteDescription(new RTCSessionDescription(w.data.sdp)).catch(()=>{});
  } else if (w.signal_type === 'ice_candidate' && w.data?.candidate) {
    const pc = roomState.peerConns.get(peerId);
    if (pc) pc.addIceCandidate(new RTCIceCandidate(w.data.candidate)).catch(()=>{});
  }
}

function closePeer(peerId) {
  const pc = roomState.peerConns.get(peerId);
  if (pc) { pc.close(); roomState.peerConns.delete(peerId); }
}

function leaveRoom() {
  if (roomState.roomId) {
    API.sendRoomSignal('leave', { room_id: roomState.roomId });
    roomState.peerConns.forEach(pc => pc.close());
    roomState.peerConns.clear();
  }
  roomState = { roomId: null, participants: [], peerConns: new Map() };
  $('#create-room-btn').textContent = '🔊';
  if (roomTimerInterval) { clearInterval(roomTimerInterval); roomTimerInterval = null; }
  roomStartTime = 0;
  const panel = document.getElementById('room-panel');
  if (panel) panel.remove();
  const invite = document.getElementById('room-invite');
  if (invite) invite.remove();
  hideCallScreen();
}

// 1对1 通话结束后也清理房间状态
const origHangUp = hangUp;
hangUp = function() {
  origHangUp();
  leaveRoom();
};

function logout() {
  API.disconnect();
  API._token = null;
  localStorage.removeItem('novachat_user');
  State.me = null;
  State.chats.clear();
  State.activePeerId = null;
  chatScreen.style.display = 'none';
  authScreen.style.display = 'flex';
  chatList.innerHTML = '';
  chatMain.innerHTML = `
    <div class="chat-placeholder">
      <div class="placeholder-logo">✧</div>
      <h2>Welcome to NovaChat</h2>
      <p>Select a chat or start a new conversation</p>
    </div>`;
}
