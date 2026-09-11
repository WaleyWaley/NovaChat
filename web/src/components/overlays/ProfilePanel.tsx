/**
 * 个人设置面板 (Phase 4.3)
 * 入口: 侧栏底部 user-info 点击。功能:
 *   - 头像: 预览 + 本地文件上传 (multipart → 网关落盘 → avatar_photo_id) + 移除
 *   - 显示名: 输入框 + 保存 (PATCH /api/users/me → user-service UpdateProfile)
 * 结构照 MenuPopup: 全屏透明 backdrop 点击关闭 + 绝对定位卡片。
 */
import { useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import Avatar from '../common/Avatar';

export default function ProfilePanel() {
  const profileOpen = useAppStore((s) => s.profileOpen);
  const setProfileOpen = useAppStore((s) => s.setProfileOpen);
  const me = useAppStore((s) => s.me);
  const updateMyName = useAppStore((s) => s.updateMyName);
  const uploadMyAvatar = useAppStore((s) => s.uploadMyAvatar);
  const removeMyAvatar = useAppStore((s) => s.removeMyAvatar);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(me?.first_name || '');
  const [busy, setBusy] = useState(false);

  if (!profileOpen || !me) return null;

  const myName = me.first_name || me.username;

  const onPickFile = () => {
    fileRef.current?.click();
  };

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 立即清空: 同一文件二次选择不触发 onChange
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    await uploadMyAvatar(file);
    setBusy(false);
  };

  const onRemoveAvatar = async () => {
    if (!confirm('Remove your avatar?')) return;
    setBusy(true);
    await removeMyAvatar();
    setBusy(false);
  };

  const onSaveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) return; // 空名网关会 400, 这里直接拦下
    setBusy(true);
    await updateMyName(trimmed);
    setBusy(false);
  };

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
        onClick={() => setProfileOpen(false)}
      />
      <div className="profile-panel">
        <div className="profile-panel-title">👤 My Profile</div>

        {/* 头像区 */}
        <div className="profile-avatar-row">
          <Avatar name={myName} size={80} avatarId={me.avatar_photo_id || null} />
          <div className="profile-avatar-actions">
            <button className="profile-btn" disabled={busy} onClick={onPickFile}>
              📷 Upload Avatar
            </button>
            <button
              className="profile-btn danger"
              disabled={busy || !me.avatar_photo_id}
              onClick={onRemoveAvatar}
            >
              🗑 Remove
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={(e) => void onFileChosen(e)}
            />
            <div className="profile-hint">PNG/JPEG/WebP/GIF, max 2MB</div>
          </div>
        </div>

        {/* 显示名区 */}
        <div className="profile-field">
          <label className="profile-label">Display name</label>
          <input
            className="profile-input"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            placeholder={myName}
          />
          <button className="profile-btn" disabled={busy} onClick={() => void onSaveName()}>
            💾 Save
          </button>
        </div>

        <div className="profile-footer">@{me.username} · user_id: {String(me.user_id)}</div>
      </div>
    </>
  );
}
