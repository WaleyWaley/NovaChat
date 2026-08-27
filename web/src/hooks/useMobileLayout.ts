/**
 * 移动端布局检测 (对应 style.css 的 @media (max-width:768px))
 */
import { useEffect, useState } from 'react';

export function useMobileLayout(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width:768px)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(max-width:768px)');
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return mobile;
}
