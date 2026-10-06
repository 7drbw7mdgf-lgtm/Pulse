importScripts('graph-engine.js');
const engine = PulseGraph.createEngine();
self.onmessage = ({data}) => {
  try {
    if (data.action === 'analyse') self.postMessage({id:data.id, result:engine.analyse(data.payload)});
    else self.postMessage({id:data.id, positions:layout(data.payload)});
  } catch (error) { self.postMessage({id:data.id,error:error.message}); }
};
function layout({papers, links, width, height, spacing}) {
  const nodes = papers.map((p,i) => ({id:p.id, pinned:p.pinnedPosition, x:p.x || width/2+Math.cos(i*2*Math.PI/papers.length)*width*.34, y:p.y || height/2+Math.sin(i*2*Math.PI/papers.length)*height*.34}));
  const byId = new Map(nodes.map(n=>[n.id,n]));
  // Strongest links determine layout; all evidence stays available in the library.
  const springs = links.slice().sort((a,b)=>b.score-a.score).slice(0,Math.max(2500,nodes.length*4));
  const cell = 160 * spacing;
  for(let tick=0;tick<58;tick++) {
    const grid=new Map(), forces=new Map(nodes.map(n=>[n.id,{x:0,y:0}]));
    nodes.forEach(n=>{const key=`${Math.floor(n.x/cell)},${Math.floor(n.y/cell)}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(n);});
    nodes.forEach(a=>{
      const cx=Math.floor(a.x/cell),cy=Math.floor(a.y/cell),f=forces.get(a.id);
      for(let gx=cx-1;gx<=cx+1;gx++)for(let gy=cy-1;gy<=cy+1;gy++)for(const b of sample(grid.get(`${gx},${gy}`)||[],tick)) {
        if(a===b)continue;const dx=a.x-b.x,dy=a.y-b.y,d=Math.max(45,Math.hypot(dx,dy));const push=1600*spacing*spacing/(d*d);f.x+=dx/d*push;f.y+=dy/d*push;
        if(Math.abs(dx)<120*spacing&&Math.abs(dy)<54*spacing){f.x+=(120*spacing-Math.abs(dx))*.08*(dx>=0?1:-1);f.y+=(54*spacing-Math.abs(dy))*.12*(dy>=0?1:-1);}
      }
      f.x+=(width/2-a.x)*.0028/Math.max(1,spacing*.75);f.y+=(height/2-a.y)*.0028/Math.max(1,spacing*.75);
    });
    springs.forEach(link=>{const a=byId.get(link.source),b=byId.get(link.target);if(!a||!b)return;const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),boost=link.type&&link.type!=='similarity'?.32:0,desired=270*spacing-link.score*105-boost*46,pull=(d-desired)*.0038*(.52+link.score+boost);const fa=forces.get(a.id),fb=forces.get(b.id);fa.x+=dx/d*pull;fa.y+=dy/d*pull;fb.x-=dx/d*pull;fb.y-=dy/d*pull;});
    nodes.forEach(n=>{if(n.pinned)return;const f=forces.get(n.id);n.x=Math.max(80,Math.min(width-80,n.x+f.x));n.y=Math.max(70,Math.min(height-70,n.y+f.y));});
  }
  return nodes;
}

function sample(bucket,tick) {
  if(bucket.length<=32)return bucket;
  return Array.from({length:32},(_,i)=>bucket[(Math.floor(i*bucket.length/32)+tick)%bucket.length]);
}
