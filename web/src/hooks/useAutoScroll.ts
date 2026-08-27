/**
 * 消息容器自动滚到底 (对应 app.js:369 的总是滚动行为)
 * deps 变化时滚动; 调用方把 ref 挂到滚动容器上。
 */
import { useEffect, type RefObject } from 'react';

export function useAutoScroll(
  ref: RefObject<HTMLElement | null>,
  deps: unknown[]
): void {
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}
