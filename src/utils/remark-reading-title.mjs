// Keep the original Markdown intact; omit a repeated article title in rendered HTML.
export default function remarkReadingTitle() {
  return (tree, file) => {
    const title = file.data.astro?.frontmatter?.title;
    if (typeof title !== "string") return;
    const index = tree.children.findIndex(node => node.type !== "yaml");
    const heading = tree.children[index];
    if (heading?.type !== "heading" || heading.depth !== 1) return;
    const text = node => node.value ?? node.children?.map(text).join("") ?? "";
    const normalize = value =>
      value.replace(/[^\p{Letter}\p{Number}]/gu, "").toLowerCase();
    if (normalize(text(heading)) === normalize(title))
      tree.children.splice(index, 1);
  };
}
