export interface ToolEntry { id?: string; repository?: string; name: string; url?: string; description?: string; status?: string; }
export function headerMarkup(options?: { active?: string; tools?: ToolEntry[]; staticTools?: boolean }): string;
export function footerMarkup(options?: { year?: number }): string;
