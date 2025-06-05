import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';

interface MyPluginSettings {
  targetFolder: string; // 统计词库目标文件夹
  proficiencyThreshold: number; // 熟练度阈值
}

const DEFAULT_SETTINGS: MyPluginSettings = {
  targetFolder: '',
  proficiencyThreshold: 300
}

export default class MyPlugin extends Plugin {
  settings: MyPluginSettings;
  
  async onload() {
    await this.loadSettings();

    // 注册命令
    this.addCommand({
      id: 'vocabulary-statistics',
      name: '统计词库',
      callback: () => this.updateEditorFromFiles()
    });

    this.addCommand({
      id: 'update-proficiency',
      name: '更新熟练度',
      callback: () => this.updateFilesFromEditor()
    });

    // 统计词库功能按钮（正向更新）
    const vocabularyIconEl = this.addRibbonIcon('book-open', '统计词库', async (evt: MouseEvent) => {
      await this.updateEditorFromFiles();
    });
    vocabularyIconEl.addClass('vocabulary-plugin-ribbon-class');

    // 反向更新按钮
    const reverseUpdateIconEl = this.addRibbonIcon('refresh-cw', '更新熟练度', async (evt: MouseEvent) => {
      await this.updateFilesFromEditor();
    });
    reverseUpdateIconEl.addClass('reverse-update-plugin-ribbon-class');

    this.addSettingTab(new SampleSettingTab(this.app, this));
  }

  onunload() {
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 正向更新：从文件元数据更新编辑器内容
  async updateEditorFromFiles() {
    const targetFolderPath = this.settings.targetFolder;
    if (!targetFolderPath) {
      new Notice('请先在设置中选择目标文件夹');
      return;
    }

    const targetFolder = this.app.vault.getAbstractFileByPath(targetFolderPath);
    if (!targetFolder || !(targetFolder instanceof TFolder)) {
      new Notice('目标文件夹不存在或不是文件夹');
      return;
    }

    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile = markdownView?.file;
    const activeFileName = activeFile?.basename || '';

    const editor = markdownView?.editor;
    if (!editor) {
      new Notice('当前没有活动的编辑器');
      return;
    }

    const content = editor.getValue();
    let updatedContent = content;
    let matchesFound = 0;
    let updatedExisting = 0; // 记录已存在链接的更新数量

    const files = this.getAllMarkdownFilesInFolder(targetFolder).filter(
      file => file.basename !== activeFileName
    );

    if (files.length === 0) {
      new Notice('目标文件夹中没有找到Markdown文件（已排除当前编辑文件）');
      return;
    }

    // 获取所有文件的熟练度，不跳过任何文件
    const fileNameToLatestProficiency = new Map<string, string>();
    for (const file of files) {
      const fileNameWithoutExt = file.basename;
      let proficiency = await this.getFileProficiency(file);
      if (!proficiency) {
        proficiency = "180";
        await this.createOrUpdateProficiency(file, proficiency);
      }
      fileNameToLatestProficiency.set(fileNameWithoutExt, proficiency);
    }

    // 第一遍：更新已存在的链接
    for (const [fileName, latestProficiency] of fileNameToLatestProficiency.entries()) {
      const pattern = new RegExp(`\\[\\[${escapeRegExp(fileName)}(?:\\|.*?|\#.*?)?\\]\\]<sup>\\d+<\\/sup>`, 'g');
      
      updatedContent = updatedContent.replace(pattern, (match) => {
        updatedExisting++;
        return match.replace(/<sup>\d+<\/sup>/, `<sup>${latestProficiency}</sup>`);
      });
    }

    // 第二遍：添加新链接
    for (const [fileName, latestProficiency] of fileNameToLatestProficiency.entries()) {
      const pattern = new RegExp(
        `(?<!\\[\\[|\\[)${escapeRegExp(fileName)}(?!\\]\\]|\\])|\\[\\[${escapeRegExp(fileName)}(?:\\|.*?|\#.*?)?\\]\\](?![^[]*<sup>)`,
        'g'
      );

      updatedContent = updatedContent.replace(pattern, (match) => {
        matchesFound++;
        if (match.startsWith('[[') && match.endsWith(']]')) {
          return `${match}<sup>${latestProficiency}</sup>`;
        } else {
          return `[[${match}]]<sup>${latestProficiency}</sup>`;
        }
      });
    }

    if (matchesFound > 0 || updatedExisting > 0) {
      let noticeMsg = '';
      if (updatedExisting > 0) {
        noticeMsg += `更新了 ${updatedExisting} 个已有链接的熟练度`;
        if (matchesFound > 0) {
          noticeMsg += `，添加了 ${matchesFound} 个新链接`;
        }
      } else {
        noticeMsg += `添加了 ${matchesFound} 个新链接`;
      }
      new Notice(noticeMsg);
      editor.setValue(updatedContent);
    } else {
      new Notice('未找到需要处理的匹配项');
    }
  }

  // 反向更新：从编辑器内容更新文件元数据
  async updateFilesFromEditor() {
    const targetFolderPath = this.settings.targetFolder;
    if (!targetFolderPath) {
      new Notice('请先在设置中选择目标文件夹');
      return;
    }

    const targetFolder = this.app.vault.getAbstractFileByPath(targetFolderPath);
    if (!targetFolder || !(targetFolder instanceof TFolder)) {
      new Notice('目标文件夹不存在或不是文件夹');
      return;
    }

    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) {
      new Notice('当前没有活动的编辑器');
      return;
    }

    const editor = markdownView.editor;
    const content = editor.getValue();
    const pattern = /\[\[([^\]]+)\]\]<sup>(\d+)<\/sup>/g;
    const matches = content.matchAll(pattern);
    
    const filesToUpdate = new Map<string, string>(); // 文件名 -> 熟练度
    const linksToRemove: { fullMatch: string, plainText: string, keyword: string }[] = [];
    const processedKeywords = new Set<string>(); // 记录已处理的关键词（按文档顺序）
    
    for (const match of matches) {
      const keyword = match[1];
      const proficiency = parseInt(match[2], 10);
      
      // 若关键词已处理，跳过后续相同关键词
      if (processedKeywords.has(keyword)) continue;
      processedKeywords.add(keyword);
      
      const file = this.findFileByName(keyword, targetFolder);
      
      // 文件不存在时记录移除链接
      if (!file) {
        linksToRemove.push({
          fullMatch: match[0],
          plainText: keyword,
          keyword: keyword
        });
        continue;
      }
      
      // 记录第一个出现的数值
      filesToUpdate.set(keyword, proficiency.toString());
      
      // 熟练度≥阈值时记录移除链接
      if (proficiency >= this.settings.proficiencyThreshold) {
        linksToRemove.push({
          fullMatch: match[0],
          plainText: keyword,
          keyword: keyword
        });
      }
    }

    // 更新文件元数据
    for (const [keyword, proficiency] of filesToUpdate.entries()) {
      const file = this.findFileByName(keyword, targetFolder);
      if (file) await this.updateFileProficiency(file, proficiency);
    }

    // 清理链接结构
    let cleanedContent = content;
    for (const { fullMatch, plainText } of linksToRemove) {
      const linkPattern = new RegExp(escapeRegExp(fullMatch), 'g');
      cleanedContent = cleanedContent.replace(linkPattern, plainText);
    }
    
    if (cleanedContent !== content) {
      editor.setValue(cleanedContent);
    }

    // 生成通知信息
    const updatedCount = filesToUpdate.size;
    const removedCount = linksToRemove.length;
    const fileNotFoundCount = linksToRemove.filter(item => !this.findFileByName(item.keyword, targetFolder)).length;
    const duplicateCount = processedKeywords.size - updatedCount;
    
    let noticeMessage = '';
    if (updatedCount > 0) {
      noticeMessage = `成功更新 ${updatedCount} 个文件的熟练度`;
      if (removedCount > 0) {
        noticeMessage += `，移除 ${removedCount} 个链接（${fileNotFoundCount} 个因文件不存在）`;
      }
      if (duplicateCount > 0) {
        noticeMessage += `，忽略 ${duplicateCount} 个重复关键词的后续数值`;
      }
    } else if (removedCount > 0) {
      noticeMessage = `未更新文件熟练度，移除 ${removedCount} 个链接（${fileNotFoundCount} 个因文件不存在）`;
    } else {
      noticeMessage = '未找到需要更新或移除的链接';
    }

    new Notice(noticeMessage);
  }

  findFileByName(name: string, folder: TFolder): TFile | null {
    for (const child of folder.children) {
      if (child instanceof TFile && child.basename === name && child.extension === 'md') {
        return child;
      } else if (child instanceof TFolder) {
        const found = this.findFileByName(name, child);
        if (found) return found;
      }
    }
    return null;
  }

  async updateFileProficiency(file: TFile, proficiency: string) {
    try {
      const fileContent = await this.app.vault.read(file);
      const metadataRegex = /---\s*\n(.*?)\n---/s;
      const metadataMatch = fileContent.match(metadataRegex);
      if (metadataMatch && metadataMatch[1]) {
        let metadata = metadataMatch[1];
        const proficiencyRegex = /^\s*熟练度:\s*\d+\s*$/gm;
        if (proficiencyRegex.test(metadata)) {
          metadata = metadata.replace(proficiencyRegex, `熟练度: ${proficiency}`);
        } else {
          metadata += `\n熟练度: ${proficiency}`;
        }
        const updatedContent = fileContent.replace(metadataRegex, `---\n${metadata}\n---`);
        await this.app.vault.modify(file, updatedContent);
      } else {
        const updatedContent = `---\n熟练度: ${proficiency}\n---\n${fileContent}`;
        await this.app.vault.modify(file, updatedContent);
      }
    } catch (error) {
      console.error(`更新文件 ${file.name} 的熟练度失败:`, error);
    }
  }

  async createOrUpdateProficiency(file: TFile, proficiency: string) {
    try {
      const fileContent = await this.app.vault.read(file);
      const metadataRegex = /---\s*\n(.*?)\n---/s;
      const metadataMatch = fileContent.match(metadataRegex);
      if (metadataMatch && metadataMatch[1]) {
        let metadata = metadataMatch[1];
        metadata += `\n熟练度: ${proficiency}`;
        const updatedContent = fileContent.replace(metadataRegex, `---\n${metadata}\n---`);
        await this.app.vault.modify(file, updatedContent);
      } else {
        const updatedContent = `---\n熟练度: ${proficiency}\n---\n${fileContent}`;
        await this.app.vault.modify(file, updatedContent);
      }
    } catch (error) {
      console.error(`创建/更新文件 ${file.name} 的熟练度失败:`, error);
    }
  }

  getAllMarkdownFilesInFolder(folder: TFolder): TFile[] {
    let result: TFile[] = [];
    folder.children.forEach(child => {
      if (child instanceof TFile && child.extension === 'md') {
        result.push(child);
      } else if (child instanceof TFolder) {
        result = result.concat(this.getAllMarkdownFilesInFolder(child));
      }
    });
    return result;
  }

  async getFileProficiency(file: TFile): Promise<string | null> {
    try {
      const fileContent = await this.app.vault.read(file);
      const metadataRegex = /---\s*\n(.*?)\n---/s;
      const metadataMatch = fileContent.match(metadataRegex);
      if (metadataMatch && metadataMatch[1]) {
        const metadataLines = metadataMatch[1].split('\n');
        const proficiencyLine = metadataLines.find(line => line.trim().startsWith('熟练度:'));
        if (proficiencyLine) {
          return proficiencyLine.trim().split(': ')[1];
        }
      }
      return null;
    } catch (error) {
      console.error('读取文件元数据失败:', error);
      return null;
    }
  }
}

class SampleSettingTab extends PluginSettingTab {
  plugin: MyPlugin;

  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('目标文件夹')
      .setDesc('选择统计词库的目标文件夹')
      .addText(text => text
        .setPlaceholder('选择文件夹...')
        .setValue(this.plugin.settings.targetFolder)
        .onChange(async (value) => {
          this.plugin.settings.targetFolder = value;
          await this.plugin.saveSettings();
        })
        .inputEl.addClass('folder-input'))
      .addButton(button => button
        .setButtonText('浏览...')
        .onClick(async () => {
          const folderChooser = new FolderChooseModal(this.app, (folderPath: string) => {
            this.plugin.settings.targetFolder = folderPath;
            this.display();
            this.plugin.saveSettings();
          });
          folderChooser.open();
        }));

    new Setting(containerEl)
      .setName('熟练度阈值')
      .setDesc('当熟练度数字≥此值时，删除链接结构（默认300）')
      .addSlider(slider => slider
        .setLimits(100, 1000, 10)
        .setValue(this.plugin.settings.proficiencyThreshold)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.proficiencyThreshold = value;
          await this.plugin.saveSettings();
        }));
  }
}

class FolderChooseModal extends Modal {
  callback: (folderPath: string) => void;
  selectedPath: string = '';

  constructor(app: App, callback: (folderPath: string) => void) {
    super(app);
    this.callback = callback;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '选择目标文件夹' });

    const folders = this.app.vault.getAllLoadedFiles()
      .filter(file => file instanceof TFolder)
      .map(folder => folder.path);

    const folderListEl = contentEl.createEl('div', { cls: 'folder-list' });
    folders.forEach(folderPath => {
      const folderEl = folderListEl.createEl('div', { cls: 'folder-item' });
      folderEl.createEl('span', { text: folderPath });
      folderEl.addEventListener('click', () => {
        folderListEl.querySelectorAll('.folder-item').forEach(item => {
          item.removeClass('selected');
        });
        folderEl.addClass('selected');
        this.selectedPath = folderPath;
      });
    });

    const buttonContainer = contentEl.createEl('div', { cls: 'button-container' });
    buttonContainer.createEl('button', { text: '取消' })
      .addEventListener('click', () => this.close());
    buttonContainer.createEl('button', { text: '选择', cls: 'mod-cta' })
      .addEventListener('click', () => {
        if (this.selectedPath) this.callback(this.selectedPath);
        this.close();
      });

    contentEl.createEl('style', { text: `
      .folder-list { max-height: 300px; overflow-y: auto; margin: 10px 0; border: 1px solid var(--background-modifier-border); border-radius: 4px; }
      .folder-item { padding: 8px 10px; cursor: pointer; display: flex; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .folder-item:hover { background-color: var(--background-modifier-hover); }
      .folder-item.selected { background-color: var(--interactive-accent); color: white; font-weight: 500; }
      .button-container { display: flex; justify-content: flex-end; gap: 10px; margin-top: 15px; padding: 10px; }
      .mod-cta { background-color: var(--interactive-accent); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
      .mod-cta:hover { opacity: 0.9; }
    `});
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// 转义正则表达式特殊字符
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}