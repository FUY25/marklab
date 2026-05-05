type EventHandler = (event?: unknown) => void;

export class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly classNames = new Set<string>();
  readonly listeners = new Map<string, EventHandler[]>();
  textContent = '';
  value = '';
  disabled = false;
  checked = false;
  readOnly = false;
  rows = 0;
  type = '';

  constructor(tagName = 'div') {
    this.tagName = tagName;
  }

  empty(): void {
    this.children.length = 0;
    this.textContent = '';
  }

  createEl(tagName: string, options: { text?: string; cls?: string; attr?: Record<string, string>; type?: string } = {}): FakeElement {
    const child = new FakeElement(tagName);
    if (options.text) child.textContent = options.text;
    if (options.cls) child.addClass(options.cls);
    if (options.type) child.type = options.type;
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      child.setAttr(name, value);
    }
    this.children.push(child);
    return child;
  }

  createDiv(options: { text?: string; cls?: string } = {}): FakeElement {
    return this.createEl('div', options);
  }

  createSpan(options: { text?: string; cls?: string } = {}): FakeElement {
    return this.createEl('span', options);
  }

  addClass(className: string): void {
    this.classNames.add(className);
  }

  setAttr(name: string, value: string): void {
    Reflect.set(this, name, value);
  }

  addEventListener(eventName: string, handler: EventHandler): void {
    const handlers = this.listeners.get(eventName) ?? [];
    handlers.push(handler);
    this.listeners.set(eventName, handlers);
  }

  click(): void {
    for (const handler of this.listeners.get('click') ?? []) {
      handler({ currentTarget: this });
    }
  }

  trigger(eventName: string): void {
    for (const handler of this.listeners.get(eventName) ?? []) {
      handler({ currentTarget: this });
    }
  }

  select(): void {
    // Selection is not modeled by tests.
  }
}

export function collectText(element: FakeElement): string {
  return [element.textContent, element.value, ...element.children.map((child) => collectText(child))].filter(Boolean).join(' ');
}

export function findElementsByTag(element: FakeElement, tagName: string): FakeElement[] {
  const matches = element.tagName === tagName ? [element] : [];
  for (const child of element.children) {
    matches.push(...findElementsByTag(child, tagName));
  }
  return matches;
}

export function findElementByText(element: FakeElement, text: string): FakeElement | null {
  if (element.textContent === text) return element;
  for (const child of element.children) {
    const match = findElementByText(child, text);
    if (match) return match;
  }
  return null;
}

export const openedModals: Modal[] = [];
export const notices: string[] = [];

export function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/');
}

export class Notice {
  constructor(readonly message: string) {
    notices.push(message);
  }
}

export class Modal {
  readonly containerEl = new FakeElement('div');
  readonly modalEl = new FakeElement('div');
  readonly titleEl = new FakeElement('div');
  readonly contentEl = new FakeElement('div');

  constructor(readonly app: unknown) {}

  open(): void {
    openedModals.push(this);
    void this.onOpen();
  }

  close(): void {
    this.onClose();
  }

  onOpen(): void | Promise<void> {}

  onClose(): void {}
}

export interface MockCommand {
  id: string;
  name: string;
  callback: () => unknown;
}

export interface MockRibbonIcon {
  icon: string;
  title: string;
  callback: (event?: unknown) => unknown;
  element: FakeElement;
}

export function createMockApp(
  activeFile: { path: string; extension: string } | null = null,
  markdownFiles: Array<{ path: string; extension: string }> = activeFile ? [activeFile] : [],
): unknown {
  return {
    workspace: {
      getActiveFile: () => activeFile,
    },
    vault: {
      adapter: {
        getFullPath: (path: string) => `/vault/${path}`,
      },
      getMarkdownFiles: () => markdownFiles.filter((file) => file.extension.toLowerCase() === 'md'),
    },
  };
}

export class Plugin {
  readonly commands: MockCommand[] = [];
  readonly ribbonIcons: MockRibbonIcon[] = [];
  readonly settingTabs: unknown[] = [];
  savedData: unknown = null;

  constructor(
    readonly app: unknown = createMockApp(),
    readonly manifest: unknown = {},
  ) {}

  async loadData(): Promise<unknown> {
    return null;
  }

  async saveData(data: unknown): Promise<void> {
    this.savedData = data;
  }

  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }

  addCommand(command: MockCommand): MockCommand {
    this.commands.push(command);
    return command;
  }

  addRibbonIcon(icon: string, title: string, callback: (event?: unknown) => unknown): FakeElement {
    const element = new FakeElement('div');
    this.ribbonIcons.push({ icon, title, callback, element });
    return element;
  }
}

export class PluginSettingTab {
  readonly containerEl = new FakeElement('div');

  constructor(
    readonly app: unknown,
    readonly plugin: unknown,
  ) {}

  display(): void {}
}

class DropdownComponent {
  readonly selectEl: FakeElement;
  private changeHandler: ((value: string) => unknown) | null = null;

  constructor(containerEl: FakeElement) {
    this.selectEl = containerEl.createEl('select');
    Reflect.set(this.selectEl, 'component', this);
  }

  addOption(value: string, display: string): this {
    const optionEl = this.selectEl.createEl('option', { text: display });
    optionEl.value = value;
    return this;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  getValue(): string {
    return this.selectEl.value;
  }

  onChange(callback: (value: string) => unknown): this {
    this.changeHandler = callback;
    return this;
  }

  triggerChange(value: string): void {
    this.setValue(value);
    this.changeHandler?.(value);
  }
}

class ButtonComponent {
  readonly buttonEl: FakeElement;

  constructor(containerEl: FakeElement) {
    this.buttonEl = containerEl.createEl('button');
  }

  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }

  setCta(): this {
    this.buttonEl.addClass('mod-cta');
    return this;
  }

  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }

  setIcon(icon: string): this {
    Reflect.set(this.buttonEl, 'icon', icon);
    return this;
  }

  setTooltip(tooltip: string): this {
    Reflect.set(this.buttonEl, 'tooltip', tooltip);
    return this;
  }

  onClick(callback: (event?: unknown) => unknown): this {
    this.buttonEl.addEventListener('click', callback);
    return this;
  }
}

class TextComponent {
  readonly inputEl: FakeElement;

  constructor(containerEl: FakeElement) {
    this.inputEl = containerEl.createEl('input');
  }

  setPlaceholder(value: string): this {
    Reflect.set(this.inputEl, 'placeholder', value);
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(_callback: (value: string) => unknown): this {
    return this;
  }
}

class ToggleComponent {
  private value = false;

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  onChange(_callback: (value: boolean) => unknown): this {
    return this;
  }
}

export class Setting {
  readonly settingEl: FakeElement;
  readonly infoEl: FakeElement;
  readonly nameEl: FakeElement;
  readonly descEl: FakeElement;
  readonly controlEl: FakeElement;
  readonly components: unknown[] = [];

  constructor(containerEl: FakeElement) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
    this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }

  setName(name: string | DocumentFragment): this {
    this.nameEl.textContent = String(name);
    return this;
  }

  setDesc(desc: string | DocumentFragment): this {
    this.descEl.textContent = String(desc);
    return this;
  }

  setClass(className: string): this {
    this.settingEl.addClass(className);
    return this;
  }

  setTooltip(tooltip: string): this {
    Reflect.set(this.settingEl, 'tooltip', tooltip);
    return this;
  }

  setHeading(): this {
    this.settingEl.addClass('setting-item-heading');
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.settingEl.disabled = disabled;
    return this;
  }

  addDropdown(callback: (component: DropdownComponent) => unknown): this {
    const component = new DropdownComponent(this.controlEl);
    this.components.push(component);
    callback(component);
    return this;
  }

  addButton(callback: (component: ButtonComponent) => unknown): this {
    const component = new ButtonComponent(this.controlEl);
    this.components.push(component);
    callback(component);
    return this;
  }

  addText(callback: (component: TextComponent) => unknown): this {
    const component = new TextComponent(this.controlEl);
    this.components.push(component);
    callback(component);
    return this;
  }

  addToggle(callback: (component: ToggleComponent) => unknown): this {
    const component = new ToggleComponent();
    this.components.push(component);
    callback(component);
    return this;
  }
}
