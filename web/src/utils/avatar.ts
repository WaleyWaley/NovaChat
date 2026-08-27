/** 头像颜色 — 逐字移植 app.js:514-515 */
const AVATAR_COLORS = ['#2ea6ff', '#e74c3c', '#f39c12', '#2ecc71', '#9b59b6', '#1abc9c', '#e67e22', '#3498db'];

export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h += name.charCodeAt(i);
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initialOf(name: string): string {
  return (name || '?')[0].toUpperCase();
}
