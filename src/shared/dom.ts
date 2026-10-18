// closest() stops at a shadow root; a mask or block on the host covers what
// the host renders, as it does in rrweb's recording
const FRAGMENT = 11;

export const closestAcross = (
  element: Element,
  selector: string,
): Element | null => {
  for (let node: Element | undefined = element; node;) {
    const found = node.closest(selector);
    if (found) return found;
    // only a shadow root leads on: document.host may be an <img name="host">
    // the page put there, which would loop here forever. Not instanceof
    // ShadowRoot: an iframe's shadow roots are of its own
    const root = node.getRootNode();
    node =
      root.nodeType === FRAGMENT
        ? (root as Partial<ShadowRoot>).host
        : undefined;
  }
  return null;
};

// a password, also one a "show password" button turned into text (rrweb
// marks it) or one whose autocomplete, name or id says so
export const isPassword = (field: Element): boolean =>
  (field as HTMLInputElement).type === "password" ||
  field.hasAttribute("data-rr-is-password") ||
  /pass|pwd/i.test(
    `${field.getAttribute("autocomplete")} ${field.getAttribute("name")} ${field.id}`,
  );
