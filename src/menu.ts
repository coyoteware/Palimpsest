/**
 * Drop-down menus for toolbar buttons: a button with `aria-haspopup="menu"`
 * opens the `role="menu"` element it controls (`aria-controls`). Items are
 * buttons with role menuitem, menuitemradio or menuitemcheckbox; arrows move
 * between them, Escape or a click outside closes the menu.
 */
export interface MenuHandlers {
  /** Called before the menu opens, to update its items. */
  beforeOpen?(menu: HTMLElement): void;
  /** An item was chosen (by click, Enter or Space). */
  choose(item: HTMLElement): void;
}

let openMenu: { button: HTMLElement; menu: HTMLElement; ac: AbortController } | null = null;

export function closeMenus(focusButton = false) {
  if (!openMenu) return;
  const { button, menu, ac } = openMenu;
  openMenu = null;
  ac.abort();
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
  if (focusButton) button.focus();
}

export const menuIsOpen = () => openMenu !== null;

const items = (menu: HTMLElement) =>
  [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter((i) => !i.hidden && !(i as HTMLButtonElement).disabled);

export function wireMenu(button: HTMLElement, handlers: MenuHandlers) {
  const menu = document.getElementById(button.getAttribute("aria-controls")!)!;
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  menu.hidden = true;

  const open = (focus: "first" | "last" | null) => {
    closeMenus();
    handlers.beforeOpen?.(menu);
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    place(button, menu);
    const ac = new AbortController();
    openMenu = { button, menu, ac };
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!menu.contains(e.target as Node) && !button.contains(e.target as Node)) closeMenus();
      },
      { capture: true, signal: ac.signal },
    );
    // Escape closes the menu wherever focus is (a click leaves it on the button).
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        closeMenus(true);
      },
      { capture: true, signal: ac.signal },
    );
    window.addEventListener("blur", () => closeMenus(), { signal: ac.signal });
    window.addEventListener("resize", () => closeMenus(), { signal: ac.signal });
    const list = items(menu);
    if (focus) (focus === "first" ? list[0] : list.at(-1))?.focus();
  };

  button.addEventListener("click", () => (openMenu?.menu === menu ? closeMenus() : open(null)));
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open(e.key === "ArrowDown" ? "first" : "last");
    }
  });
  menu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[role^="menuitem"]');
    if (!item || (item as HTMLButtonElement).disabled) return;
    closeMenus(true);
    handlers.choose(item);
  });
  menu.addEventListener("keydown", (e) => {
    const list = items(menu);
    const at = list.indexOf(document.activeElement as HTMLElement);
    let to = -1;
    if (e.key === "ArrowDown") to = (at + 1) % list.length;
    else if (e.key === "ArrowUp") to = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = list.length - 1;
    else if (e.key === "Tab") {
      closeMenus();
      return;
    }
    if (to < 0) return;
    e.preventDefault();
    list[to]?.focus();
  });
}

/** Below the button, kept inside the window. */
function place(button: HTMLElement, menu: HTMLElement) {
  const b = button.getBoundingClientRect();
  menu.style.top = `${Math.round(b.bottom + 4)}px`;
  menu.style.left = "0px";
  const width = menu.offsetWidth;
  const left = Math.max(8, Math.min(b.left, window.innerWidth - width - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.maxHeight = `${Math.max(120, window.innerHeight - b.bottom - 16)}px`;
}

/** Mark the radio items of `group` so that the one with `value` is checked. */
export function checkRadio(menu: HTMLElement, group: string, value: string) {
  for (const item of menu.querySelectorAll<HTMLElement>(`[role="menuitemradio"][data-group="${group}"]`)) {
    item.setAttribute("aria-checked", String(item.dataset.value === value));
  }
}
