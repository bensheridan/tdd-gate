const cache = new Map<string, string>();

export function clearCache() {
    cache.clear();
}

export function slugify(title: string): string {
    const hit = cache.get(title);
    if (hit !== undefined) return hit;
    const slug = title
        .toLowerCase()
        .replace(/ /g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/^-+|-+$/g, "");
    cache.set(title, slug);
    return slug;
}
