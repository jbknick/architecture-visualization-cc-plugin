import { useState } from "react";
import { useDebounce } from "../hooks/useDebounce";
import { slugify } from "../lib/slug";

export function PostList() {
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 250);
  return (
    <div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <p>{slugify(debounced)}</p>
    </div>
  );
}
