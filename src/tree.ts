import { groupsFor, naturalCompare, normalizeTags, resolveGroup, tagMatches } from "./config";
import type { ReviewCenterSettings, ReviewMode, ReviewScope, SourceRecord } from "./types";
export interface ReviewTreeNode extends ReviewScope { id: string; label: string; children: ReviewTreeNode[] }
export function scopeKey(scope: ReviewScope): string { return JSON.stringify([scope.mode, scope.groupId, scope.tagPath ?? ""]); }
export function buildReviewTree(records: SourceRecord[], settings: ReviewCenterSettings, mode: ReviewMode): ReviewTreeNode[] {
  return groupsFor(settings, mode).map((group) => {
    const root: ReviewTreeNode = { mode, groupId: group.id, id: "", label: group.name, children: [] };
    root.id = scopeKey(root);
    const prefixes = normalizeTags(group.tags).sort(naturalCompare).filter((tag, _, all) => !all.some((other) => other !== tag && tagMatches(tag, other)));
    const nodes = new Map<string, ReviewTreeNode>();
    const add = (path: string, parent: ReviewTreeNode, label: string): ReviewTreeNode => {
      let node = nodes.get(path);
      if (!node) {
        node = { mode, groupId: group.id, tagPath: path, id: scopeKey({ mode, groupId: group.id, tagPath: path }), label, children: [] };
        parent.children.push(node); nodes.set(path, node);
      }
      return node;
    };
    const actual = records.filter((r) => r.sourceStatus !== "deleted" && resolveGroup(r.tags, groupsFor(settings, mode))?.id === group.id).flatMap((r) => normalizeTags(r.tags));
    for (const prefix of prefixes) {
      const base = prefixes.length === 1 ? root : add(prefix, root, prefix);
      for (const tag of [...new Set(actual)].filter((t) => tagMatches(t, prefix)).sort(naturalCompare)) {
        let parent = base, path = prefix;
        for (const part of tag.slice(prefix.length).split("/").filter(Boolean)) {
          path += "/" + part; parent = add(path, parent, part);
        }
      }
    }
    return root;
  });
}
export function flattenTree(nodes: ReviewTreeNode[]): ReviewTreeNode[] { return nodes.flatMap((n) => [n, ...flattenTree(n.children)]); }
