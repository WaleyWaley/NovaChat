/**
 * 圆形头像: 优先显示图片头像, 否则回退首字母 + 按名字哈希的颜色。
 *
 * Phase 4.3: avatarId 是 user-service 存的 avatar_photo_id (文件名或完整 URL)。
 * 文件名拼 /avatars/<id> 由 nginx 从共享卷静态服务; 图片加载失败 (文件被删、
 * 本地 dev 无 nginx 等) 自动回退首字母色块。
 */
import { useEffect, useState } from 'react';
import { avatarColor, initialOf } from '../../utils/avatar';

interface Props {
  name: string;
  size?: number; // px, 默认 48
  className?: string;
  avatarId?: string | null;
}

export default function Avatar({ name, size = 48, className, avatarId }: Props) {
  const [failed, setFailed] = useState(false);

  // 换了头像 (或清空) 时重置加载失败状态
  useEffect(() => setFailed(false), [avatarId]);

  const url = avatarId
    ? /^https?:\/\//.test(avatarId)
      ? avatarId // 完整 URL (外链)
      : `/avatars/${avatarId}` // 本地文件名 (nginx 静态服务)
    : null;

  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        className={className}
        onError={() => setFailed(true)}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: avatarColor(name),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.375),
        fontWeight: 700,
        color: '#fff',
        flexShrink: 0,
      }}
    >
      {initialOf(name)}
    </div>
  );
}
