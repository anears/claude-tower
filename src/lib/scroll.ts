// Given a selected index and a viewport capacity, return the index of the first
// item to render so that the selected item stays visible (centered when possible).
export function windowStart(selected: number, total: number, capacity: number): number {
  if (total <= capacity) return 0;
  let start = selected - Math.floor(capacity / 2);
  if (start < 0) start = 0;
  if (start > total - capacity) start = total - capacity;
  return start;
}
