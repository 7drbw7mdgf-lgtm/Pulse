"""Smoke-test a disposable Tauri bundle with isolated library and download paths."""
import json
import os
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

SCRIPT = r'''<script>
window.addEventListener('load', async () => {
  const errors=[];window.addEventListener('error',e=>errors.push(e.message));
  const wait=async predicate=>{for(let i=0;i<400;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25));}throw Error('Native check timed out');};
  const check=(value,message)=>{if(!value)throw Error(message);};
  try {
    await wait(()=>state.autosaveReady);
    const health=await (await fetch(backendUrl('/api/health'),{headers:apiHeaders()})).json();
    state.autosaveReady=false;
    state.papers=[normalizeImportedPaper({id:'early',title:'Graph methods for scientific retrieval',year:'2018',authors:['Fixture Author'],text:'graph retrieval scientific research'},'fixture'),normalizeImportedPaper({id:'late',title:'Graph learning for scientific retrieval',year:'2024',authors:['Fixture Author'],text:'graph retrieval scientific research'},'fixture')];
    state.mode='network';state.selectedId='early';render();
    check(document.querySelectorAll('#map .node').length===2,'Network nodes missing');
    const revision=relatednessRevision;state.selectedId='late';render();check(relatednessRevision===revision,'Selection repeated analysis');
    document.querySelector('[data-rail="timeline"]').click();
    check([...document.querySelectorAll('.timeline-paper')].map(p=>p.dataset.year).join(',')==='2018,2024','Timeline ordering failed');
    document.querySelector('[data-timeline-paper]').click();check(state.selectedId==='early','Timeline selection failed');
    document.querySelector('[data-timeline-graph]').click();check(state.mode==='network','Return to network failed');
    document.querySelector('#labelModeInput').value='none';document.querySelector('#labelModeInput').dispatchEvent(new Event('change'));check(document.querySelectorAll('.node-label').length===0,'Label filter failed');
    document.querySelector('[data-rail="settings"]').click();check(!els.settingsPanel.hidden,'Settings did not open');
    document.querySelector('#autoGemmaInput').checked=false;document.querySelector('#saveSettingsButton').click();await wait(()=>!els.saveSettingsButton.disabled);document.querySelector('#settingsCloseButton').click();
    const settings=await (await fetch(backendUrl('/api/settings'),{headers:apiHeaders()})).json();check(settings.autoGemmaExtraction===false,'Settings not persisted');
    const exportStart=performance.now();document.querySelector('#exportButton').click();await new Promise(r=>setTimeout(r,1000));document.querySelector('#summaryExportButton').click();
    const payload=serializeMap();payload.papers.push({...payload.papers[0],id:'imported',title:'Imported native fixture',year:'2022'});
    const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(payload)],'fixture.json',{type:'application/json'}));els.importInput.files=transfer.files;els.importInput.dispatchEvent(new Event('change'));await wait(()=>state.papers.some(p=>p.id==='imported'));
    check(!document.querySelector('[data-rail="collections"]'),'Collections still present');
    await new Promise(r=>setTimeout(r,1500));check(errors.length===0,errors.join(';'));
    await fetch(backendUrl('/api/library'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({...serializeMap(),_nativeReport:{ok:true,health,papers:state.papers.length,timeline:true,settings:true,imports:true,errors}})});
  }catch(error){await fetch(backendUrl('/api/library'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({papers:[],_nativeReport:{ok:false,error:error.message}})});}
});
</script>'''


def main():
    source=Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='pulse-native-check-') as folder:
        temp=Path(folder).resolve();app=temp/'Pulse.app';shutil.copytree(source,app)
        plist=app/'Contents/Info.plist'
        info=plistlib.loads(plist.read_bytes());info['CFBundleIdentifier']='com.pulse.nativecheck.'+str(time.time_ns());plist.write_bytes(plistlib.dumps(info))
        html=app/'Contents/Resources/resources/backend/index.html'
        html.write_text(html.read_text().replace('</body>',SCRIPT+'</body>'))
        subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],check=True,capture_output=True)
        config=temp/'config';exports=temp/'exports';exports.mkdir()
        env=dict(os.environ,PULSE_CONFIG_DIR=str(config),PULSE_EXPORT_DIR=str(exports),PULSE_DISABLE_BUNDLED_OLLAMA='1',PYTHONDONTWRITEBYTECODE='1')
        with (temp/'native.log').open('w') as log:
            process=subprocess.Popen([str(app/'Contents/MacOS/pulse-desktop'), '-ApplePersistenceIgnoreState', 'YES'],env=env,stdout=log,stderr=subprocess.STDOUT)
            try:
                deadline=time.monotonic()+90
                while time.monotonic()<deadline:
                    file=config/'library.json'
                    if file.exists():
                        report=json.loads(file.read_text()).get('_nativeReport')
                        if report:
                            assert report['ok'],report
                            assert report['papers']==3,report
                            assert sorted(p.name for p in exports.iterdir())==['paper-linkage-map.json','pulse-summary-table.csv'],list(exports.iterdir())
                            assert len(json.loads((exports/'paper-linkage-map.json').read_text())['papers'])==2
                            print('PASS: native Tauri handshake, Network, Timeline, settings, import, JSON/CSV downloads and cached selection',flush=True)
                            print(json.dumps(report),flush=True)
                            break
                    if process.poll() is not None:raise RuntimeError((temp/'native.log').read_text()[-2000:])
                    time.sleep(.2)
                else:
                    backend_log=config/'backend.log'
                    raise RuntimeError('Native check timed out: '+(backend_log.read_text()[-2500:] if backend_log.exists() else (temp/'native.log').read_text()[-2500:]))
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()


if __name__=='__main__':main()
