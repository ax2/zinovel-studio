import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { NovelStore } from '../../packages/novel-storage/store.mjs';
import { claimDesktopSingleInstance } from './upstream/single-instance';
import { desktopNodeEnvironment } from './upstream/node-environment';
import { NovelHarness } from '../../packages/novel-harness/runtime.mjs';
import { ModelSettings } from './settings';

app.setName('ZiNovel Studio');
const dataRoot = process.env.ZINOVEL_DATA_ROOT || join(app.getPath('appData'), 'ZiNovel Studio');
app.setPath('userData', dataRoot);
const store = new NovelStore(join(dataRoot, 'library'));
const settings = new ModelSettings(dataRoot);
const harness = new NovelHarness({root:dataRoot, resources:resolve(__dirname,'../resources'), environment:desktopNodeEnvironment(process.execPath, undefined, process.env)});
const entry = resolve(__dirname, '../workbench/index.html');
let window: BrowserWindow | undefined;
let closing = false;

if (claimDesktopSingleInstance(app, () => { window?.show(); window?.focus(); })) {
  app.whenReady().then(async () => {
    await store.initialize();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [{ label: '退出', click: () => window?.close() }] },
      { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    ]));
    ipcMain.handle('novel:request', async (event, action: string, payload: Record<string, any> = {}) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(entry).href) throw new Error('拒绝未授权窗口');
      try {
        let value: unknown;
        switch (action) {
          case 'library.list': value = await store.listBooks(); break;
          case 'book.create': value = await store.createBook(payload.title); break;
          case 'chapter.create': value = await store.createChapter(payload.bookId, payload.title); break;
          case 'chapter.read': value = await store.readChapter(payload.bookId, payload.chapterId); break;
          case 'chapter.save': value = await store.saveChapter(payload); break;
          case 'chapter.history': value = await store.history(payload.bookId, payload.chapterId); break;
          case 'skills.list': value = await harness.skills(); break;
          case 'settings.get': value = await settings.public(); break;
          case 'settings.save': value = await settings.save(payload as Parameters<ModelSettings['save']>[0]); break;
          case 'ai.generate': { const config = await settings.secret(); value = await harness.generate({skillId:payload.skillId,instruction:payload.instruction,context:payload.context,selectedText:payload.selectedText}, config.settings, config.apiKey); break; }
          case 'ai.cancel': await harness.cancel(); value = { cancelled:true }; break;
          case 'chapter.export': {
            const chapter = await store.readChapter(payload.bookId, payload.chapterId);
            const selected = await dialog.showSaveDialog(window, { title: '导出章节', defaultPath: `${chapter.title.replace(/[<>:"/\\|?*]/g, '_')}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
            if (!selected.canceled && selected.filePath) await writeFile(selected.filePath, `# ${chapter.title}\n\n${chapter.body}`, 'utf8');
            value = { cancelled: selected.canceled }; break;
          }
          case 'app.close-ready': await harness.cancel(); closing = true; window.close(); return { ok: true };
          default: throw new Error('不支持的操作');
        }
        return { ok: true, value };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败，原稿已保留' }; }
    });
    window = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600, title: 'ZiNovel Studio', backgroundColor: '#f7f9fa', autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(entry).href) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window.on('close', event => {
      if (closing) return;
      event.preventDefault(); window?.webContents.send('novel:closing');
    });
    await window.loadFile(entry);
  }).catch(error => { dialog.showErrorBox('ZiNovel Studio 启动失败', String(error)); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
