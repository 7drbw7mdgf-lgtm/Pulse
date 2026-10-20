(function (root) {
  'use strict';
  class PulseUpdates {
    constructor({invoke, channel, save, render = () => {}, freeze = () => {}, notify = () => {}}) {
      Object.assign(this, {invoke, channel, save, render, freeze, notify});
      this.info = {}; this.busy = ''; this.error = ''; this.progress = null;
    }
    draw() { this.render({info:this.info, busy:this.busy, error:this.error, progress:this.progress}); }
    async init() { this.info = await this.invoke('pulse_update_info'); this.draw(); }
    async check(manual = false) {
      if (this.busy) return;
      this.busy = 'checking'; this.error = ''; this.draw();
      try { this.info = await this.invoke('pulse_update_check'); }
      catch (error) { this.error = String(error?.message || error); }
      this.busy = ''; this.draw();
      if (!this.error && this.info.availableVersion && !this.info.ready && this.info.autoDownload && this.info.canUpdate) await this.download();
      else if (manual && !this.error && !this.info.availableVersion) this.notify('Pulse is up to date.');
    }
    async download() {
      if (this.busy || !this.info.availableVersion || this.info.ready || !this.info.canUpdate) return;
      this.busy = 'downloading'; this.error = ''; this.progress = null; this.draw();
      const onEvent = this.channel();
      onEvent.onmessage = event => { this.progress = event; this.draw(); };
      try { this.info = await this.invoke('pulse_update_download', {onEvent}); }
      catch (error) { this.error = String(error?.message || error); }
      this.busy = ''; this.progress = null; this.draw();
    }
    async cancel() {
      if (this.busy !== 'downloading') return;
      try { await this.invoke('pulse_update_cancel'); } catch (error) { this.error = String(error?.message || error); this.draw(); }
    }
    async preferences(autoDownload) {
      try {
        this.info = await this.invoke('pulse_update_preferences', {autoDownload}); this.error = ''; this.draw();
        if (autoDownload && !this.busy && this.info.availableVersion && !this.info.ready) await this.download();
      } catch (error) { this.error = String(error?.message || error); this.draw(); }
    }
    async install() {
      if (this.busy || !this.info.ready) return;
      this.busy = 'saving'; this.error = ''; this.freeze(true); this.draw();
      try {
        if (await this.save() !== true) throw Error('Your latest library changes could not be saved. Resolve the save problem, then retry the update.');
        this.busy = 'installing'; this.draw();
        await this.invoke('pulse_update_install');
      } catch (error) {
        this.error = String(error?.message || error); this.busy = ''; this.freeze(false); this.draw();
      }
    }
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = PulseUpdates; return; }
  root.PulseUpdates = PulseUpdates;
  document.addEventListener('DOMContentLoaded', async () => {
    const api = root.__TAURI__?.core, get = id => document.getElementById(id);
    const status = get('pulseUpdateStatus'), check = get('pulseUpdateCheck'), download = get('pulseUpdateDownload');
    const install = get('pulseUpdateInstall'), cancel = get('pulseUpdateCancel'), auto = get('pulseUpdateAuto');
    if (!status) return;
    if (!api?.invoke || !api.Channel) {
      status.textContent = 'Automatic updates are available in the Pulse desktop app. This browser workspace stays as it is.';
      check.disabled = auto.disabled = true; return;
    }
    const current = get('pulseUpdateVersion'), notes = get('pulseUpdateNotes'), progress = get('pulseUpdateProgress'), banner = get('pulseUpdateBanner');
    const controller = new PulseUpdates({
      invoke: (command, args) => api.invoke(command, args), channel: () => new api.Channel(),
      save: async () => {
        if (!state.autosaveReady || state.libraryMutation || state.clearingLibrary || (typeof managerUi !== 'undefined' && managerUi.syncing)) throw Error('Wait for the library operation to finish, then restart Pulse.');
        clearTimeout(state.autosaveTimer);
        await Promise.all([...(state.pendingLibraryWrites || [])]);
        return await saveLibrary();
      },
      freeze: value => {
        state.pulseUpdateRestarting = value;
        const app = document.getElementById('app'); if (app) app.inert = value;
        get('pulseUpdateRestartOverlay').hidden = !value;
      },
      notify: message => typeof showToast === 'function' && showToast(message),
      render: ({info, busy, error, progress: event}) => {
        current.textContent = info.currentVersion ? `Installed version ${info.currentVersion}` : 'Pulse desktop';
        auto.checked = info.autoDownload !== false;
        check.disabled = !!busy; auto.disabled = busy === 'saving' || busy === 'installing';
        download.hidden = !info.availableVersion || info.ready || !info.canUpdate;
        download.disabled = !!busy;
        cancel.hidden = busy !== 'downloading';
        install.hidden = !info.ready; install.disabled = !!busy;
        notes.textContent = info.notes || ''; notes.hidden = !info.notes;
        progress.hidden = busy !== 'downloading';
        if (event?.total) progress.value = Math.min(1, event.downloaded / event.total); else progress.removeAttribute('value');
        let text = info.availableVersion ? `Pulse ${info.availableVersion} is available.` : info.lastChecked ? 'Pulse is up to date.' : 'Check GitHub for the latest Pulse release.';
        if (info.ready) text = `Pulse ${info.availableVersion} is downloaded and verified. Restart when you are ready.`;
        if (!info.canUpdate) text = 'Move Pulse from the disk image into Applications, then reopen it to enable updates.';
        if (busy === 'checking') text = 'Checking GitHub for updates…';
        if (busy === 'downloading') text = event?.phase === 'verifying' ? 'Verifying the update signature…' : event?.total ? `Downloading update · ${Math.round(event.downloaded / 1000000)} / ${Math.round(event.total / 1000000)} MB` : 'Downloading update from GitHub…';
        if (busy === 'saving') text = 'Saving your library before restarting…';
        if (busy === 'installing') text = 'Installing the update and restarting Pulse…';
        status.textContent = error || text; status.classList.toggle('update-error', !!error);
        banner.hidden = !info.ready || busy === 'installing';
        get('pulseUpdateBannerText').textContent = `Pulse ${info.availableVersion || ''} is ready`;
      }
    });
    check.addEventListener('click', () => controller.check(true));
    download.addEventListener('click', () => controller.download()); cancel.addEventListener('click', () => controller.cancel());
    install.addEventListener('click', () => controller.install());
    get('pulseUpdateBannerRestart').addEventListener('click', () => controller.install());
    get('pulseUpdateBannerDetails').addEventListener('click', () => { setSettingsOpen(true); setSettingsTab('updates'); });
    auto.addEventListener('change', () => controller.preferences(auto.checked));
    try {
      await controller.init();
      setTimeout(() => controller.check(), 2000);
      setInterval(() => { if (document.visibilityState !== 'hidden') controller.check(); }, 6 * 60 * 60 * 1000);
    } catch (_) { status.textContent = 'This desktop build does not support in-app updates yet. Install the latest Pulse once to enable them.'; check.disabled = auto.disabled = true; }
  });
})(typeof window !== 'undefined' ? window : globalThis);
