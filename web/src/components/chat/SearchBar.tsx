/**
 * 用户搜索框 (对应 app.js:202-215)
 * 通过 ref 暴露 focusAndReset, 供 "+" 新建按钮调用。
 */
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { searchUsers } from '../../api/rest';
import { useAppStore } from '../../store/useAppStore';

export interface SearchBarHandle {
  focusAndReset: () => void;
}

const SearchBar = forwardRef<SearchBarHandle>(function SearchBar(_props, ref) {
  const [value, setValue] = useState('');
  const [placeholder, setPlaceholder] = useState('Search users...');
  const setSearchResults = useAppStore((s) => s.setSearchResults);
  const upsertUserName = useAppStore((s) => s.upsertUserName);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusAndReset: () => {
      setValue('');
      setPlaceholder('Search username to start chat...');
      inputRef.current?.focus();
    },
  }));

  const onEnter = async () => {
    const query = value.trim();
    if (!query) return;
    try {
      const result = await searchUsers(query);
      if (result.users) {
        // 缓存名字 (对应 app.js renderSearchResults:225-226)
        result.users.forEach((u) => upsertUserName(String(u.user_id), u.first_name || u.username));
        setSearchResults(result.users);
      }
    } catch (err) {
      console.error('Search failed:', err);
    }
  };

  return (
    <input
      id="search-input"
      ref={inputRef}
      type="text"
      placeholder={placeholder}
      style={{ flex: 1 }}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void onEnter();
      }}
    />
  );
});

export default SearchBar;
