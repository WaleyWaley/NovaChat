/**
 * 圆形头像: 首字母 + 按名字哈希的颜色 (对应 app.js createChatItem / openChat 里的头像逻辑)
 */
import { avatarColor, initialOf } from '../../utils/avatar';

interface Props {
  name: string;
  size?: number; // px, 默认 48
  className?: string;
}

export default function Avatar({ name, size = 48, className }: Props) {
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
