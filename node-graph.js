/* node-graph.js — dependency-free SVG hierarchy visualiser.
 *
 * Shared by taxonomy-studio.html and hierarchy-explorer.html. Plain classic
 * script (no modules) so it loads from file:// as well as from a static host.
 *
 *   var g = NodeGraph.create(containerEl, { onSelect: fn });
 *   g.setData({ nodes: [{id,label,parent,badge,tone,data}], links: [{from,to,kind,label}] });
 *   g.setLayout('tree-h'|'tree-v'|'radial'|'indent');
 *
 * Nodes form a forest by `parent`. Anything whose parent is missing or absent
 * becomes a root; parent cycles are broken and flagged rather than hanging.
 * `links` draw as dashed curves on top of the tree, for relationships that are
 * not containment — crosswalk mappings, reporting lines, spouse edges.
 */
(function(global){
"use strict";

var NS="http://www.w3.org/2000/svg";
function svg(tag,attrs){
  var e=document.createElementNS(NS,tag);
  if(attrs) for(var k in attrs) e.setAttribute(k,attrs[k]);
  return e;
}
var _ctx=null;
function textWidth(s,font){
  if(!_ctx){ var c=document.createElement("canvas"); _ctx=c.getContext("2d") }
  _ctx.font=font||"12px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  return _ctx.measureText(String(s==null?"":s)).width;
}

function create(container,opts){
  opts=opts||{};
  var NODE_H=opts.nodeHeight||26, GAP_X=opts.gapX||54, GAP_Y=opts.gapY||12;
  var MAXW=opts.maxNodeWidth||230, MINW=opts.minNodeWidth||54;

  var state={
    raw:{nodes:[],links:[]},
    layout:"tree-h",
    collapsed:{},        // id -> true
    selected:null,
    query:"",
    hits:{},
    tx:40, ty:40, k:1,
    roots:[], byId:{}, flagged:[]
  };

  container.textContent="";
  // Only establish a containing block if the page has not positioned this
  // element itself. Forcing `relative` here would override an `absolute;
  // inset:0` container, collapsing it to the 150px default SVG height.
  if(getComputedStyle(container).position==="static") container.style.position="relative";
  container.style.overflow="hidden";
  container.style.touchAction="none";

  var root=svg("svg",{width:"100%",height:"100%"});
  root.style.display="block";
  root.style.cursor="grab";
  var defs=svg("defs");
  // one arrow marker per edge flavour
  [["ng-arrow","var(--ng-edge, #b9b9b2)"],["ng-arrow-x","var(--ng-xlink, #8a6bbf)"]].forEach(function(p){
    var m=svg("marker",{id:p[0],viewBox:"0 0 10 10",refX:"9",refY:"5",
      markerWidth:"5",markerHeight:"5",orient:"auto-start-reverse"});
    m.appendChild(svg("path",{d:"M0,0 L10,5 L0,10 z",fill:p[1]}));
    defs.appendChild(m);
  });
  root.appendChild(defs);
  var vp=svg("g");
  var gEdges=svg("g"), gXLinks=svg("g"), gNodes=svg("g");
  vp.appendChild(gEdges); vp.appendChild(gXLinks); vp.appendChild(gNodes);
  root.appendChild(vp);
  container.appendChild(root);

  var empty=document.createElement("div");
  empty.style.cssText="position:absolute;inset:0;display:none;align-items:center;justify-content:center;"+
    "color:var(--ng-muted,#8a8a83);font:13px ui-sans-serif,system-ui,sans-serif;pointer-events:none";
  container.appendChild(empty);

  /* ---------------------------------------------------------- build forest */
  function build(){
    var nodes=state.raw.nodes||[];
    state.byId={};
    // Several passes can notice the same problem; report each one once.
    var _seenFlag={};
    state.flagged=[];
    state.flagged.push=function(f){
      var k=f.id+"|"+f.why;
      if(_seenFlag[k]) return state.flagged.length;
      _seenFlag[k]=1;
      return Array.prototype.push.call(state.flagged,f);
    };
    nodes.forEach(function(n){
      if(n.id==null) return;
      var id=String(n.id);
      if(state.byId[id]){ state.flagged.push({id:id,why:"duplicate id"}); return }
      state.byId[id]={id:id,label:n.label==null?id:String(n.label),badge:n.badge,tone:n.tone,
                      data:n.data,parentRaw:n.parent==null?null:String(n.parent),children:[],
                      depth:0,cycle:false,orphan:false};
    });
    var roots=[];
    Object.keys(state.byId).forEach(function(id){
      var n=state.byId[id];
      var p=n.parentRaw;
      if(p==null||p===""||p===id){ roots.push(n); if(p===id){ n.cycle=true;
        state.flagged.push({id:id,why:"points at itself as parent"}) } return }
      var parent=state.byId[p];
      if(!parent){ n.orphan=true; roots.push(n);
        state.flagged.push({id:id,why:"parent “"+p+"” does not exist"}); return }
      parent.children.push(n);
    });
    // Break any remaining cycles: walk up from each node, and if we return to a
    // node already on the path, detach it to a root. Without this the layout
    // recursion never terminates.
    Object.keys(state.byId).forEach(function(id){
      var seen={}, cur=state.byId[id];
      while(cur){
        if(seen[cur.id]){
          var p=state.byId[cur.parentRaw];
          if(p){ p.children=p.children.filter(function(c){return c!==cur}) }
          cur.cycle=true; cur.parentRaw=null;
          if(roots.indexOf(cur)<0) roots.push(cur);
          state.flagged.push({id:cur.id,why:"parent chain forms a cycle"});
          break;
        }
        seen[cur.id]=1;
        cur=cur.parentRaw?state.byId[cur.parentRaw]:null;
      }
    });
    roots.sort(function(a,b){ return a.label.localeCompare(b.label) });
    (function sortKids(list){ list.forEach(function(n){
      n.children.sort(function(a,b){ return a.label.localeCompare(b.label) }); sortKids(n.children) }) })(roots);
    state.roots=roots;
  }

  function descendants(n){ var c=0; n.children.forEach(function(k){ c+=1+descendants(k) }); return c }

  /* --------------------------------------------------------------- layout */
  function layout(){
    var pos=0, rows=[];
    function walk(n,depth){
      n.depth=depth;
      n.w=Math.max(MINW,Math.min(MAXW,textWidth(n.label)+ (n.badge?34:0) + 26));
      var kids=state.collapsed[n.id]?[]:n.children;
      if(!kids.length){ n.pos=pos++; }
      else { kids.forEach(function(k){ walk(k,depth+1) });
             n.pos=(kids[0].pos+kids[kids.length-1].pos)/2 }
      rows.push(n);
    }
    state.roots.forEach(function(r){ walk(r,0) });
    var total=Math.max(1,pos);

    var maxW={}; rows.forEach(function(n){ maxW[n.depth]=Math.max(maxW[n.depth]||0,n.w) });
    var colX={},acc=0;
    Object.keys(maxW).map(Number).sort(function(a,b){return a-b}).forEach(function(d){
      colX[d]=acc; acc+=maxW[d]+GAP_X;
    });

    var L=state.layout;
    rows.forEach(function(n){
      if(L==="tree-h"){ n.x=colX[n.depth]; n.y=n.pos*(NODE_H+GAP_Y); n.anchor="w" }
      else if(L==="tree-v"){ n.x=n.pos*(MAXW*0.55+GAP_Y); n.y=n.depth*(NODE_H+GAP_X*0.75); n.anchor="n" }
      else if(L==="indent"){ n.x=n.depth*22; n.y=rowsIndex(n)*(NODE_H+4); n.anchor="w" }
      else { // radial
        var a=(n.pos/total)*Math.PI*2-Math.PI/2;
        var r=n.depth*(Math.max.apply(null,Object.keys(maxW).map(function(d){return maxW[d]}))*0.55+GAP_X);
        n.x=Math.cos(a)*r; n.y=Math.sin(a)*r; n.anchor="c"; n.angle=a;
      }
    });
    return rows;
  }
  var _indentOrder=null;
  function rowsIndex(n){ return _indentOrder[n.id] }
  function buildIndentOrder(){
    _indentOrder={}; var i=0;
    (function walk(list){ list.forEach(function(n){
      _indentOrder[n.id]=i++;
      if(!state.collapsed[n.id]) walk(n.children) }) })(state.roots);
  }

  /* --------------------------------------------------------------- render */
  function render(){
    gEdges.textContent=""; gXLinks.textContent=""; gNodes.textContent="";
    if(!state.roots.length){
      empty.style.display="flex";
      empty.textContent=opts.emptyText||"Nothing to show yet.";
      return;
    }
    empty.style.display="none";
    if(state.layout==="indent") buildIndentOrder();
    var rows=layout();

    rows.forEach(function(n){
      if(!n.parentRaw) return;
      var p=state.byId[n.parentRaw];
      if(!p||state.collapsed[p.id]) return;
      gEdges.appendChild(svg("path",{d:edgePath(p,n),fill:"none",
        stroke:"var(--ng-edge,#b9b9b2)","stroke-width":"1.2"}));
    });

    (state.raw.links||[]).forEach(function(l){
      var a=state.byId[String(l.from)], b=state.byId[String(l.to)];
      if(!a||!b) return;
      if(hiddenByCollapse(a)||hiddenByCollapse(b)) return;
      var p=svg("path",{d:crossPath(a,b),fill:"none",stroke:"var(--ng-xlink,#8a6bbf)",
        "stroke-width":"1.3","stroke-dasharray":"4 3","marker-end":"url(#ng-arrow-x)",opacity:"0.85"});
      if(l.kind) p.appendChild(titleEl(l.kind+(l.label?": "+l.label:"")));
      gXLinks.appendChild(p);
    });

    rows.forEach(function(n){ gNodes.appendChild(nodeEl(n)) });
  }
  function titleEl(t){ var e=svg("title"); e.textContent=t; return e }
  function hiddenByCollapse(n){
    var cur=n.parentRaw?state.byId[n.parentRaw]:null;
    while(cur){ if(state.collapsed[cur.id]) return true; cur=cur.parentRaw?state.byId[cur.parentRaw]:null }
    return false;
  }
  function edgePath(p,n){
    if(state.layout==="tree-h"||state.layout==="indent"){
      var x1=p.x+p.w, y1=p.y+NODE_H/2, x2=n.x, y2=n.y+NODE_H/2, mx=(x1+x2)/2;
      return "M"+x1+","+y1+" C"+mx+","+y1+" "+mx+","+y2+" "+x2+","+y2;
    }
    if(state.layout==="tree-v"){
      var a1=p.x+p.w/2, b1=p.y+NODE_H, a2=n.x+n.w/2, b2=n.y, my=(b1+b2)/2;
      return "M"+a1+","+b1+" C"+a1+","+my+" "+a2+","+my+" "+a2+","+b2;
    }
    return "M"+p.x+","+p.y+" Q"+((p.x+n.x)/2*0.7)+","+((p.y+n.y)/2*0.7)+" "+n.x+","+n.y;
  }
  function crossPath(a,b){
    var x1=a.x+(state.layout==="radial"?0:a.w/2), y1=a.y+(state.layout==="radial"?0:NODE_H/2);
    var x2=b.x+(state.layout==="radial"?0:b.w/2), y2=b.y+(state.layout==="radial"?0:NODE_H/2);
    var dx=x2-x1, dy=y2-y1, d=Math.sqrt(dx*dx+dy*dy)||1;
    var cx=(x1+x2)/2 - dy/d*Math.min(90,d*0.28);
    var cy=(y1+y2)/2 + dx/d*Math.min(90,d*0.28);
    return "M"+x1+","+y1+" Q"+cx+","+cy+" "+x2+","+y2;
  }
  function nodeEl(n){
    var g=svg("g",{transform:"translate("+(state.layout==="radial"?n.x-n.w/2:n.x)+","+
      (state.layout==="radial"?n.y-NODE_H/2:n.y)+")",class:"ng-node"});
    g.style.cursor="pointer";
    var hid=descendants(n), isCol=!!state.collapsed[n.id];
    var fill = n.tone ? "var(--ng-tone-"+n.tone+", var(--ng-node,#fff))" : "var(--ng-node,#fff)";
    var stroke = state.selected===n.id ? "var(--ng-accent,#2f6f4f)"
               : state.hits[n.id] ? "var(--ng-hit,#c08a2e)"
               : n.cycle||n.orphan ? "var(--ng-bad,#a3241f)" : "var(--ng-line,#d8d8d2)";
    var r=svg("rect",{x:0,y:0,width:n.w,height:NODE_H,rx:6,fill:fill,stroke:stroke,
      "stroke-width":(state.selected===n.id||state.hits[n.id])?"2":"1"});
    g.appendChild(r);
    var t=svg("text",{x:9,y:NODE_H/2+4,fill:"var(--ng-ink,#1b1b19)","font-size":"12",
      "font-family":"ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"});
    var label=n.label, avail=n.w-18-(n.badge?30:0);
    while(label.length>3&&textWidth(label)>avail) label=label.slice(0,-2);
    if(label!==n.label) label=label.slice(0,-1)+"…";
    t.textContent=label;
    g.appendChild(t);
    if(n.badge!=null){
      var bw=Math.max(18,textWidth(String(n.badge),"10px ui-sans-serif")+12);
      g.appendChild(svg("rect",{x:n.w-bw-6,y:5,width:bw,height:NODE_H-10,rx:(NODE_H-10)/2,
        fill:"var(--ng-badge,#ecece7)"}));
      var bt=svg("text",{x:n.w-bw/2-6,y:NODE_H/2+3.5,"text-anchor":"middle",
        "font-size":"10",fill:"var(--ng-ink2,#5c5c57)",
        "font-family":"ui-sans-serif, system-ui, sans-serif"});
      bt.textContent=String(n.badge); g.appendChild(bt);
    }
    if(n.children.length){
      var cx = state.layout==="tree-v" ? n.w/2 : (state.layout==="indent"||state.layout==="tree-h" ? n.w+1 : n.w+1);
      var cy = state.layout==="tree-v" ? NODE_H+1 : NODE_H/2;
      var knob=svg("g",{transform:"translate("+cx+","+cy+")"});
      knob.appendChild(svg("circle",{r:7,fill:"var(--ng-node,#fff)",stroke:"var(--ng-line,#d8d8d2)"}));
      var sign=svg("text",{y:3.5,"text-anchor":"middle","font-size":"10",
        fill:"var(--ng-ink2,#5c5c57)","font-family":"ui-sans-serif, system-ui, sans-serif"});
      sign.textContent=isCol?"+":"−";
      knob.appendChild(sign);
      knob.style.cursor="pointer";
      knob.appendChild(titleEl(isCol?("expand "+hid+" hidden"):"collapse"));
      knob.addEventListener("mousedown",function(e){ e.stopPropagation() });
      knob.addEventListener("click",function(e){
        e.stopPropagation();
        if(state.collapsed[n.id]) delete state.collapsed[n.id]; else state.collapsed[n.id]=true;
        render();
      });
      g.appendChild(knob);
    }
    g.appendChild(titleEl(n.label+(n.cycle?"  [cycle]":"")+(n.orphan?"  [missing parent]":"")+
      (n.children.length?"  · "+descendants(n)+" below":"")));
    g.addEventListener("click",function(e){
      e.stopPropagation();
      state.selected=n.id; render();
      if(opts.onSelect) opts.onSelect(n.id,n.data,n);
    });
    g.addEventListener("dblclick",function(e){
      e.stopPropagation();
      if(opts.onActivate) opts.onActivate(n.id,n.data,n);
    });
    return g;
  }

  /* ------------------------------------------------------------ transform */
  function applyT(){ vp.setAttribute("transform","translate("+state.tx+","+state.ty+") scale("+state.k+")") }
  var dragging=false,sx=0,sy=0;
  root.addEventListener("mousedown",function(e){ dragging=true; userMoved=true;
    sx=e.clientX-state.tx; sy=e.clientY-state.ty; root.style.cursor="grabbing" });
  window.addEventListener("mousemove",function(e){ if(!dragging)return;
    state.tx=e.clientX-sx; state.ty=e.clientY-sy; applyT() });
  window.addEventListener("mouseup",function(){ dragging=false; root.style.cursor="grab" });
  root.addEventListener("wheel",function(e){
    e.preventDefault(); userMoved=true;
    var r=root.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
    var f=e.deltaY<0?1.12:1/1.12, nk=Math.max(0.12,Math.min(3.5,state.k*f));
    state.tx=mx-(mx-state.tx)*(nk/state.k);
    state.ty=my-(my-state.ty)*(nk/state.k);
    state.k=nk; applyT();
  },{passive:false});

  function bbox(){
    var b=gNodes.getBBox?gNodes.getBBox():null;
    if(!b||!b.width) return null;
    return b;
  }
  // Set once the viewer pans or zooms, so an automatic refit never yanks the
  // view out from under them.
  var userMoved=false;
  function fit(){
    var b=bbox(); if(!b||!b.width||!b.height) return;
    var r=root.getBoundingClientRect();
    // A container that has not been laid out yet reports a tiny or zero box,
    // and fitting to that bakes in a nonsense zoom. Wait for the resize instead.
    if(r.width<40||r.height<40) return;
    var k=Math.min((r.width-50)/b.width,(r.height-50)/b.height,1.6);
    if(!isFinite(k)||k<=0) k=1;
    state.k=k;
    state.tx=(r.width-b.width*k)/2-b.x*k;
    state.ty=(r.height-b.height*k)/2-b.y*k;
    applyT();
    userMoved=false;
  }
  if(window.ResizeObserver){
    var pending=null;
    new ResizeObserver(function(){
      if(userMoved) return;
      clearTimeout(pending);
      pending=setTimeout(fit,60);
    }).observe(container);
  }

  /* ----------------------------------------------------------------- API */
  var api={
    setData:function(d){
      state.raw={nodes:(d&&d.nodes)||[],links:(d&&d.links)||[]};
      build(); render(); return api;
    },
    setLayout:function(l){ state.layout=l; render(); return api },
    getLayout:function(){ return state.layout },
    setSearch:function(q){
      state.query=q||""; state.hits={};
      if(state.query){
        var s=state.query.toLowerCase();
        Object.keys(state.byId).forEach(function(id){
          var n=state.byId[id];
          if(n.label.toLowerCase().indexOf(s)>=0||id.toLowerCase().indexOf(s)>=0) state.hits[id]=1;
        });
        // reveal every hit by opening its ancestors
        Object.keys(state.hits).forEach(function(id){
          var cur=state.byId[id];
          while(cur&&cur.parentRaw){ delete state.collapsed[cur.parentRaw]; cur=state.byId[cur.parentRaw] }
        });
      }
      render(); return api;
    },
    hitCount:function(){ return Object.keys(state.hits).length },
    select:function(id){ state.selected=id==null?null:String(id); render(); return api },
    selected:function(){ return state.selected },
    reveal:function(id){
      var cur=state.byId[String(id)];
      if(!cur) return api;
      var c=cur;
      while(c&&c.parentRaw){ delete state.collapsed[c.parentRaw]; c=state.byId[c.parentRaw] }
      state.selected=String(id); render();
      var n=state.byId[String(id)];
      if(n){
        var r=root.getBoundingClientRect();
        state.tx=r.width/2-(n.x+n.w/2)*state.k;
        state.ty=r.height/2-(n.y+NODE_H/2)*state.k;
        applyT();
      }
      return api;
    },
    collapseToDepth:function(d){
      state.collapsed={};
      if(d>=0) Object.keys(state.byId).forEach(function(id){
        var n=state.byId[id]; if(n.children.length&&n.depth>=d) state.collapsed[id]=true });
      render(); return api;
    },
    expandAll:function(){ state.collapsed={}; render(); return api },
    fit:fit,
    zoom:function(f){ userMoved=true; state.k=Math.max(0.12,Math.min(3.5,state.k*f)); applyT(); return api },
    flagged:function(){ return state.flagged.slice() },
    stats:function(){
      var depth=0,count=0,leaves=0;
      Object.keys(state.byId).forEach(function(id){
        var n=state.byId[id]; count++;
        if(n.depth>depth) depth=n.depth;
        if(!n.children.length) leaves++;
      });
      return {nodes:count,roots:state.roots.length,depth:depth+1,leaves:leaves,
              flagged:state.flagged.length};
    },
    ancestors:function(id){
      var out=[],cur=state.byId[String(id)];
      while(cur&&cur.parentRaw){ cur=state.byId[cur.parentRaw]; if(cur) out.push(cur.id) }
      return out;
    },
    exportSVG:function(){
      var b=bbox(); if(!b) return "";
      var clone=root.cloneNode(true);
      clone.setAttribute("xmlns",NS);
      clone.setAttribute("width",Math.ceil(b.width+80));
      clone.setAttribute("height",Math.ceil(b.height+80));
      clone.setAttribute("viewBox",(b.x-40)+" "+(b.y-40)+" "+(b.width+80)+" "+(b.height+80));
      var g=clone.querySelector("g"); if(g) g.removeAttribute("transform");
      // inline the custom properties the live page supplies, so the file stands alone
      var cs=getComputedStyle(container);
      var map={"--ng-edge":"#b9b9b2","--ng-xlink":"#8a6bbf","--ng-node":"#ffffff","--ng-line":"#d8d8d2",
        "--ng-ink":"#1b1b19","--ng-ink2":"#5c5c57","--ng-badge":"#ecece7","--ng-accent":"#2f6f4f",
        "--ng-hit":"#c08a2e","--ng-bad":"#a3241f"};
      var out=new XMLSerializer().serializeToString(clone);
      Object.keys(map).forEach(function(v){
        var val=(cs.getPropertyValue(v)||"").trim()||map[v];
        out=out.split("var("+v+", "+map[v]+")").join(val).split("var("+v+","+map[v]+")").join(val);
      });
      out=out.replace(/var\(--ng-[a-z0-9-]+(,\s*([^)]*))?\)/g,function(_,__,fb){ return fb||"#888" });
      return '<?xml version="1.0" encoding="UTF-8"?>\n'+out;
    }
  };
  return api;
}

global.NodeGraph={create:create,textWidth:textWidth};
})(window);
