export interface PaginationQuery {
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function parsePagination(query: PaginationQuery, defaults = { page: 1, pageSize: 20 }) {
  const page = Math.max(1, Number(query.page) || defaults.page);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || defaults.pageSize));
  return { page, pageSize };
}
