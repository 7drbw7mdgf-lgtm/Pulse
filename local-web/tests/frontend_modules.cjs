// Frontend scripts stay small and named for what they do.
const fs=require('fs'),path=require('path'),assert=require('assert');
const frontend=path.join(__dirname,'../pulse-frontend');
const scripts=[...fs.readdirSync(path.join(frontend,'js')).map(name=>'js/'+name),...fs.readdirSync(frontend)].filter(name=>name.endsWith('.js'));
const limit=500,oversized=[],numbered=[];
for(const name of scripts){
  const lines=fs.readFileSync(path.join(frontend,name),'utf8').replace(/\n$/,'').split('\n').length;
  if(lines>limit)oversized.push(`${name} (${lines} lines)`);
  if(/(^|\/)part_\d+\.js$/.test(name))numbered.push(name);
}
assert.deepEqual(oversized,[],`Split scripts over ${limit} lines into named modules: ${oversized.join(', ')}`);
assert.deepEqual(numbered,[],'Name scripts for what they contain, not by number');
const html=fs.readFileSync(path.join(frontend,'index.html'),'utf8');
const missing=[...html.matchAll(/<script src="([^"?]+\.js)/g)].map(match=>match[1]).filter(name=>!fs.existsSync(path.join(frontend,name)));
assert.deepEqual(missing,[],'index.html loads only scripts that exist');
console.log(`PASS: ${scripts.length} frontend scripts, each at most ${limit} lines and named for its contents; index.html loads existing scripts.`);
