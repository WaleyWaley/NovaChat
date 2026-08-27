/**
 * 顶部居中 Toast 栈 — 样式与旧 app.js:495-503 的 inline 样式一致
 * (2500ms 后由 store 自动移除)
 */
import { useAppStore, type Toast } from '../store/useAppStore';

const BG: Record<Toast['type'], string> = {
  success: '#4caf50',
  error: '#e74c3c',
  info: 'var(--accent)',
};

export default function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <>
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            position: 'fixed',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: BG[t.type],
            color: '#fff',
            padding: '12px 28px',
            borderRadius: '12px',
            fontSize: '14px',
            fontWeight: 600,
            zIndex: 99999,
            animation: 'toastIn 0.3s ease',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}
        >
          {t.text}
        </div>
      ))}
    </>
  );
}
