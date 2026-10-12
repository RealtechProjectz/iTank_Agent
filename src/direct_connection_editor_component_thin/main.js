(() => {
  "use strict";
  const READY="streamlit:componentReady", SET_VALUE="streamlit:setComponentValue", SET_HEIGHT="streamlit:setFrameHeight", RENDER="streamlit:render";
  const root=document.getElementById("root");
  let argsState={}, routes={}, components={}, selectedEdge=null, selectedComponents=new Set(), clipboard=[], drag=null, zoom=1, panX=0, panY=0, snap=true, grid=.25, lastHeight=-1, contextMenu=null, initialSnapshot=null, history=[], historyIndex=-1, dirty=false, routeIdsByComponent=new Map(), lastRenderRevision="", overlayRenderQueued=false;
  // deviceId → ohtId for user-linked Valve/FM docks (survives header route rebuild).
  let explicitOhtInlineAssignments=new Map();
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const clonePoints=p=>(p||[]).map(q=>[Number(q[0]),Number(q[1])]);
  const cloneBox=b=>Array.isArray(b)&&b.length===4?b.map(Number):[0,0,1,1];
  const eid=()=>{
    try{
      if(typeof crypto!=="undefined"&&typeof crypto.randomUUID==="function"){
        return crypto.randomUUID();
      }
    }catch(_){}
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  };
  let dragOnlyWindowListeners=[];
  let dragOnlyRouteAction=null;
  let appliedAutoRouteToken="";
  const worksheetTools={setManualDraw(){}};
  // Module-level drag lock: Streamlit remounts must not tear down an active
  // first-grab drag session (local activeDrag dies with renderDragOnly).
  let liveComponentDrag=null;
  let liveComponentDragWindowListeners=[];

  function componentAllowsAcronymDisplay(component){
    return !!(component&&String(component.component||"").trim());
  }
  function componentDisplayMode(component){
    if(!componentAllowsAcronymDisplay(component))return"icons";
    const raw=component&&(component.display_mode||component.displayMode||component.symbol_mode);
    const mode=String(raw||"icons").trim().toLowerCase();
    return mode==="acronyms"||mode==="acronym"||mode==="letters"?"acronyms":"icons";
  }
  function componentAcronymText(component){
    const raw=String(
      (component&&(component.acronym||component.code||component.title||component.component))||"?"
    ).trim();
    return raw||"?";
  }
  function acronymFontSizeFromPixels(pxW,pxH,text){
    const width=Math.max(1,Number(pxW)||1);
    const height=Math.max(1,Number(pxH)||1);
    const label=String(text||"?").trim()||"?";
    const chars=Math.max(1,label.length);
    // Leave room for border/padding so glyphs never clip the box edges.
    const pad=Math.max(2,Math.min(width,height)*0.12);
    const availW=Math.max(2,width-pad*2);
    const availH=Math.max(2,height-pad*2);
    const byHeight=availH*0.78;
    const byWidth=availW/(chars*0.62);
    return Math.max(5,Math.min(40,Math.floor(Math.min(byHeight,byWidth))));
  }
  function acronymFontSizeForBox(box,text){
    const w=Math.max(0.01,Number(box&&box[2])||0.01);
    const h=Math.max(0.01,Number(box&&box[3])||0.01);
    // Fallback estimate when the DOM box has not been measured yet.
    return acronymFontSizeFromPixels(w*48,h*48,text);
  }
  function fitAcronymBoxFont(el,box){
    if(!el)return;
    const label=String(el.textContent||"").trim()||"?";
    let pxW=0;
    let pxH=0;
    try{
      const rect=el.getBoundingClientRect();
      pxW=Number(rect.width)||0;
      pxH=Number(rect.height)||0;
    }catch(_){}
    if(pxW<2||pxH<2){
      el.style.fontSize=`${acronymFontSizeForBox(box,label)}px`;
      return;
    }
    el.style.fontSize=`${acronymFontSizeFromPixels(pxW,pxH,label)}px`;
  }
  function paintComponentDisplayModeControl(control,component){
    if(!control)return;
    const mode=componentDisplayMode(component);
    if(control.tagName==="SELECT"){
      control.value=mode;
    }else{
      control.textContent=mode==="acronyms"?"Icon":"Aa";
    }
    control.title=mode==="acronyms"
      ?"Display: Acronym Box (switch to Graphic Icon)"
      :"Display: Graphic Icon (switch to Acronym Box)";
    control.setAttribute("aria-label","Component display mode");
  }

  // Pointer interaction helpers only. Keep all geometry/routing/rendering logic
  // unchanged while coalescing high-frequency pointermove events to one update
  // per animation frame.
  function pointerFrameSnapshot(e){
    return {
      pointerId:e.pointerId,
      clientX:Number(e.clientX)||0,
      clientY:Number(e.clientY)||0,
      button:Number(e.button)||0,
      buttons:Number(e.buttons)||0,
      pointerType:String(e.pointerType||""),
      altKey:!!e.altKey,
      shiftKey:!!e.shiftKey,
      ctrlKey:!!e.ctrlKey,
      metaKey:!!e.metaKey
    };
  }

  function createRafPointerQueue(handler){
    let frameId=0;
    let pending=null;

    const run=()=>{
      frameId=0;
      const next=pending;
      pending=null;
      if(next)handler(next);
    };

    return {
      push(e){
        pending=pointerFrameSnapshot(e);
        if(!frameId)frameId=requestAnimationFrame(run);
      },
      flush(e=null){
        if(e)pending=pointerFrameSnapshot(e);
        if(frameId){
          cancelAnimationFrame(frameId);
          frameId=0;
        }
        const next=pending;
        pending=null;
        if(next)handler(next);
      },
      cancel(){
        if(frameId)cancelAnimationFrame(frameId);
        frameId=0;
        pending=null;
      }
    };
  }
  function post(type,extra={}){if(window.parent===window)return;window.parent.postMessage(Object.assign({isStreamlitMessage:true,type},extra),"*");}
  function ready(){post(READY,{apiVersion:1});} function emit(type,extra={}){post(SET_VALUE,{value:Object.assign({type,event_id:eid()},extra)});}
  let componentAddGuard="";
  function requestWorksheetComponentAdd(component,instanceId,sourceComponent){
    const token=`${String(component||"")}|${String(instanceId||"")}`;
    const now=Date.now();
    const marker=componentAddGuard.split("|");
    const previousToken=marker.slice(0,-1).join("|");
    const previousAt=Number(marker[marker.length-1]||0);
    if(previousToken===token&&now-previousAt<700)return;
    componentAddGuard=`${token}|${now}`;
    if(sourceComponent)optimisticWorksheetAdd(sourceComponent);
    emit("component_add",{component:String(component||""),instance_id:String(instanceId||"")});
  }

  // Movement-only state for the normal Worksheet.
  // Streamlit setComponentValue triggers a Python rerun, so component/line/arrow
  // drag completion must stay browser-local instead.
  function movementDraftStorageKey(){
    const key=String(argsState.local_draft_key||"").trim();
    return key?`rts:${key}`:"";
  }

  // Restore-only endpoint anchoring helper. Automatic topology changes can add
  // a fresh server route while browser-local component positions are restored
  // from the movement draft. Preserve the route itself, but resolve each real
  // source/target endpoint back onto the component boundary so a regenerated
  // connection can never remain visually detached from its component image.
  function draftPortReference(box,point){
    if(!Array.isArray(box)||box.length!==4||!Array.isArray(point)||point.length<2)return null;
    const [x,y,w,h]=box.map(Number);
    const px=Number(point[0]),py=Number(point[1]);
    const safeW=Math.max(Math.abs(w),1e-9),safeH=Math.max(Math.abs(h),1e-9);
    const candidates=[
      {side:"left",distance:Math.abs(px-x),ratio:clamp((py-y)/safeH,0,1)},
      {side:"right",distance:Math.abs(px-(x+w)),ratio:clamp((py-y)/safeH,0,1)},
      {side:"top",distance:Math.abs(py-y),ratio:clamp((px-x)/safeW,0,1)},
      {side:"bottom",distance:Math.abs(py-(y+h)),ratio:clamp((px-x)/safeW,0,1)}
    ];
    candidates.sort((a,b)=>a.distance-b.distance);
    return {side:candidates[0].side,ratio:Number(candidates[0].ratio)};
  }

  function draftResolvePortReference(box,reference){
    if(!Array.isArray(box)||box.length!==4||!reference)return null;
    const [x,y,w,h]=box.map(Number);
    const ratio=clamp(Number(reference.ratio)||0,0,1);
    if(reference.side==="left")return[x,y+h*ratio];
    if(reference.side==="right")return[x+w,y+h*ratio];
    if(reference.side==="top")return[x+w*ratio,y];
    if(reference.side==="bottom")return[x+w*ratio,y+h];
    return null;
  }

  function draftSegmentIsHorizontal(a,b){
    if(!a||!b)return true;
    return Math.abs(Number(b[0])-Number(a[0]))>=Math.abs(Number(b[1])-Number(a[1]));
  }

  function draftAttachEndpoint(points,isSource,portPoint){
    const result=clonePoints(points);
    if(result.length<2||!Array.isArray(portPoint)||portPoint.length<2)return result;
    const locked=[Number(portPoint[0]),Number(portPoint[1])];

    if(result.length===2){
      const source=clonePoints([result[0]])[0];
      const target=clonePoints([result[1]])[0];
      const horizontal=draftSegmentIsHorizontal(source,target);
      if(isSource){source[0]=locked[0];source[1]=locked[1];}
      else{target[0]=locked[0];target[1]=locked[1];}

      if(horizontal){
        const midX=(source[0]+target[0])/2;
        return [source,[midX,source[1]],[midX,target[1]],target];
      }
      const midY=(source[1]+target[1])/2;
      return [source,[source[0],midY],[target[0],midY],target];
    }

    if(isSource){
      const horizontal=draftSegmentIsHorizontal(result[0],result[1]);
      result[0]=locked;
      if(horizontal)result[1][1]=locked[1];
      else result[1][0]=locked[0];
    }else{
      const last=result.length-1;
      const horizontal=draftSegmentIsHorizontal(result[last-1],result[last]);
      result[last]=locked;
      if(horizontal)result[last-1][1]=locked[1];
      else result[last-1][0]=locked[0];
    }
    return result;
  }

  function dottedTransmitterUsesInternalTank(route,endIsSource){
    if(!route||!route.dotted)return false;
    const embeds=Array.isArray(argsState.oht_sensor_embeds)?argsState.oht_sensor_embeds:[];
    const sourceId=String(route.source||"");
    const targetId=String(route.target||"");
    const sourceName=String(components[sourceId]?.component||"");
    const targetName=String(components[targetId]?.component||"");
    const tankId=endIsSource?sourceId:targetId;
    const tankName=endIsSource?sourceName:targetName;
    const otherName=endIsSource?targetName:sourceName;
    if(tankName!=="OHT Tank"||otherName!=="Transmitter")return false;
    return embeds.some(item=>String(item&&item.tank_id||"")===tankId);
  }
  function saveMovementDraft(){
    const key=movementDraftStorageKey();
    if(!key)return;
    try{
      sessionStorage.setItem(key,JSON.stringify({
        route_draft_version:"orthogonal-candidate-v83",
        routes:Object.values(routes).map(r=>({
          edge_id:String(r.edge_id||""),
          source:String(r.source||""),
          target:String(r.target||""),
          manual_drag:!!r.manual_drag,
          points:clonePoints(r.points)
        })),
        components:Object.values(components).map(c=>{
          let box=cloneBox(c.box);
          const parentId=String(c&&c.__oht_parent_id||"");
          if(c&&c.__oht_attached_sensor&&components[parentId]&&Array.isArray(components[parentId].box)){
            box=ohtAttachedSensorBox(components[parentId].box);
          }
          return {
          instance_id:String(c.instance_id||""),
            box,
            user_dragged:!!(c&&c.__user_dragged),
            // Survive Streamlit remounts (e.g. deleting another component).
            display_mode:componentDisplayMode(c)
          };
        })
      }));
    }catch(_){}
  }
  function pointOnBoxEdge(point, box){
    if(!Array.isArray(point)||point.length<2||!Array.isArray(box)||box.length<4)return false;
    const x=Number(box[0]), y=Number(box[1]), w=Number(box[2]), h=Number(box[3]);
    const px=Number(point[0]), py=Number(point[1]);
    if(!(w>0)||!(h>0)||!Number.isFinite(px)||!Number.isFinite(py))return false;
    const tol=0.12;
    if(px<x-tol||px>x+w+tol||py<y-tol||py>y+h+tol)return false;
    return Math.abs(px-x)<=tol||Math.abs(px-(x+w))<=tol||Math.abs(py-y)<=tol||Math.abs(py-(y+h))<=tol;
  }

  function componentWaterKind(component){
    const name=String(component?.component||"").trim().toLowerCase();
    const title=String(component?.title||"").trim().toLowerCase();
    if(name.startsWith("sump")||title.startsWith("sump"))return "sump";
    if(name.includes("bore")||title.includes("bore")||name==="well"||title==="well")return "bore";
    if(name.startsWith("oht")||title.startsWith("oht")||name==="oht tank")return "oht";
    return "";
  }

  function sharedWaterHeaderY(){
    let minTop=Infinity;
    Object.values(components).forEach(component=>{
      if(!component||component.hidden||!Array.isArray(component.box)||component.box.length<4)return;
      const kind=componentWaterKind(component);
      if(kind!=="sump"&&kind!=="oht")return;
      minTop=Math.min(minTop,Number(component.box[1]));
    });
    if(!Number.isFinite(minTop))return null;
    const [,canvasHeight]=canvasSize();
    const gap=Math.max(0.32,Number(canvasHeight||7.5)*0.045);
    return Math.max(0.18,minTop-gap);
  }

  function boxPort(box, toward){
    const x=Number(box[0]), y=Number(box[1]), w=Number(box[2]), h=Number(box[3]);
    const cx=x+w/2, cy=y+h/2;
    const dx=Number(toward[0])-cx, dy=Number(toward[1])-cy;
    if(Math.abs(dx)>=Math.abs(dy))return dx>=0?[x+w,cy]:[x,cy];
    return dy>=0?[cx,y+h]:[cx,y];
  }

  function waterLoopForComponents(sourceId, targetId){
    const source=components[sourceId];
    const target=components[targetId];
    if(!source||!target||!Array.isArray(source.box)||source.box.length<4||!Array.isArray(target.box)||target.box.length<4)return null;
    const sourceKind=componentWaterKind(source);
    const targetKind=componentWaterKind(target);
    const kinds=new Set([sourceKind, targetKind]);
    if(kinds.has("sump")&&kinds.has("oht")){
      const sump=sourceKind==="sump"?source.box:target.box;
      const tank=sourceKind==="sump"?target.box:source.box;
      const sx=Number(sump[0]), sy=Number(sump[1]), sw=Number(sump[2]);
      const tx=Number(tank[0]), ty=Number(tank[1]), tw=Number(tank[2]);
      const sumpX=sx+sw/2;
      const [,canvasHeight]=canvasSize();
      const gap=Math.max(0.32, Number(canvasHeight||7.5)*0.045);
      let headerY=sharedWaterHeaderY();
      if(headerY==null)headerY=Math.min(sy, ty)-gap;
      headerY=Math.max(0.08, Math.min(Number(headerY), Math.min(sy, ty)-gap));
      const inlet=ohtTankInletPoint(tank);
      const tankX=inlet[0];
      const tankEndY=inlet[1];
      // Continuous rise → header → drop onto the OHT icon inlet.
      const path=[[sumpX, sy],[sumpX, headerY],[tankX, headerY],[tankX, tankEndY]];
      if(sourceKind!=="sump")path.reverse();
      return path;
    }
    if(kinds.has("bore")&&kinds.has("sump")){
      const bore=sourceKind==="bore"?source.box:target.box;
      const sump=sourceKind==="bore"?target.box:source.box;
      const bx=Number(bore[0]), by=Number(bore[1]), bw=Number(bore[2]), bh=Number(bore[3]);
      const sx=Number(sump[0]), sy=Number(sump[1]), sw=Number(sump[2]), sh=Number(sump[3]);
      const borePoint=bx>=sx?[bx, by+bh/2]:[bx+bw, by+bh/2];
      const sumpPoint=(sx+sw)<=bx?[sx+sw, sy+sh/2]:[sx, sy+sh/2];
      let path;
      if(Math.abs(borePoint[1]-sumpPoint[1])<=0.001)path=[borePoint, sumpPoint];
      else{
        const midX=(borePoint[0]+sumpPoint[0])/2;
        path=[borePoint, [midX, borePoint[1]], [midX, sumpPoint[1]], sumpPoint];
      }
      if(sourceKind!=="bore")path=path.slice().reverse();
      return path;
    }
    return null;
  }

  function isInlineProcessComponent(component){
    const name=String(component?.component||component?.title||"").toLowerCase();
    if(name.includes("flow meter")||name.includes("flowmeter"))return true;
    return (
      name.includes("motorized valve")||
      name.includes("pressure relief")||
      name.includes("non-return")||
      name.includes("non return")
    );
  }

  function routePairIsWater(route){
    if(!route)return false;
    if(route.fluid_header||route.sketch_lock)return true;
    const edgeId=String(route.edge_id||"");
    if(edgeId.startsWith("fluid_header_"))return true;
    const sourceId=String(route.source||"");
    const targetId=String(route.target||"");
    const waterPrefixes=["sump_","oht_","bore_","well_"];
    const inlinePrefixes=["mv_","prv_","nrv_","ufm_","ffm_","emfm_"];
    if(
      waterPrefixes.some(prefix=>sourceId.startsWith(prefix))&&
      waterPrefixes.some(prefix=>targetId.startsWith(prefix))
    )return true;
    const sourceComp=components[sourceId]||{component:"",title:""};
    const targetComp=components[targetId]||{component:"",title:""};
    const sourceKind=componentWaterKind(sourceComp);
    const targetKind=componentWaterKind(targetComp);
    if(sourceKind&&targetKind)return true;
    const sourceWater=!!sourceKind||waterPrefixes.some(prefix=>sourceId.startsWith(prefix));
    const targetWater=!!targetKind||waterPrefixes.some(prefix=>targetId.startsWith(prefix));
    const sourceInline=(
      isInlineProcessComponent(sourceComp)||
      inlinePrefixes.some(prefix=>sourceId.startsWith(prefix))
    );
    const targetInline=(
      isInlineProcessComponent(targetComp)||
      inlinePrefixes.some(prefix=>targetId.startsWith(prefix))
    );
    return (sourceWater&&targetInline)||(sourceInline&&targetWater);
  }

  function applySolidBlueWaterStroke(line,route){
    if(!line)return;
    const water=routePairIsWater(route);
    if(water){
      route.dotted=false;
      route.color="#123DBD";
      line.setAttribute("stroke","#123DBD");
      line.setAttribute("stroke-dasharray","none");
      line.style.strokeDasharray="none";
      return;
    }
    if(route&&route.dotted){
      line.setAttribute("stroke","#000000");
      line.setAttribute("stroke-dasharray","0.026 0.052");
      line.style.strokeDasharray="0.026 0.052";
      return;
    }
    line.setAttribute("stroke","#123DBD");
    line.setAttribute("stroke-dasharray","none");
    line.style.strokeDasharray="none";
  }

  function hydraulicRoleOf(component){
    const name=String(component?.component||component?.title||"").toLowerCase();
    const id=String(component?.instance_id||"").toLowerCase();
    if(name.includes("motorized valve")||id.startsWith("mv_"))return "mv";
    if(name.includes("non-return")||name.includes("non return")||id.startsWith("nrv_"))return "nrv";
    if(name.includes("pressure relief")||id.startsWith("prv_"))return "prv";
    if(name.startsWith("motor")||id.startsWith("motor_"))return "motor";
    if(name.includes("flow meter")||name.includes("flowmeter")||id.startsWith("ufm_")||id.startsWith("ffm_")||id.startsWith("emfm_"))return "fm";
    return "";
  }

  function purgeSyntheticFluidHeaderRoutes(){
    // Phantom cleanup ONLY: delete header/dock synthetics. Never delete or
    // rewrite real Sump↔OHT / Bore↔SMC / LLS↔OHT / user-drawn edges.
    Object.keys(routes).forEach(edgeId=>{
      const id=String(edgeId||"");
      if(
        id.startsWith("fluid_header_")||
        id.startsWith("fluid_oht_inline_dock__")
      ){
        delete routes[edgeId];
      }
    });
  }

  function restoreHeaderSuppressedSumpOhtRoutes(){
    Object.values(routes).forEach(route=>{
      if(!route||!route.hidden_by_fluid_header)return;
      route.hidden=false;
      delete route.hidden_by_fluid_header;
    });
  }

  function ohtTankInletPoint(tankBox){
    // The drawn OHT icon is shifted down inside its layout box (viewport
    // safety inset). The inlet is the top-center of that icon, not the box edge
    // that sits in the gap above the roof.
    const x=Number(tankBox[0]), y=Number(tankBox[1]);
    const w=Number(tankBox[2]), h=Number(tankBox[3]);
    const [,ch]=canvasSize();
    const marginY=Math.max(0.02, (18/550)*Number(ch||1));
    const inletY=Math.min(y+Math.max(0, h)*0.42, Math.max(y, marginY));
    return [x+w/2, inletY];
  }

  function classicSumpOhtHeaderPath(sumpBox, tankBox, headerY){
    const sumpX=Number(sumpBox[0])+Number(sumpBox[2])/2;
    const sumpTop=Number(sumpBox[1]);
    const inlet=ohtTankInletPoint(tankBox);
    const above=Math.min(sumpTop, inlet[1])-0.12;
    const y=Math.max(0.08, Math.min(Number(headerY), above));
    return [
      [sumpX, sumpTop],
      [sumpX, y],
      [inlet[0], y],
      inlet
    ];
  }

  function forceUnifiedFluidHeader(){
    // 1) Clear orphan header synthetics (phantoms).
    // 2) Restore any previously suppressed Sump↔OHT edges.
    // 3) For each active Sump↔OHT pair, keep that edge and repair its path to
    //    the continuous rise→header→drop geometry. User-drawn custom points
    //    are never overwritten. All other edges stay immutable.
    const sumps=Object.values(components).filter(c=>c&&!c.hidden&&String(c.instance_id||"").startsWith("sump_")&&Array.isArray(c.box));
    const ohts=Object.values(components).filter(c=>c&&!c.hidden&&String(c.instance_id||"").startsWith("oht_")&&Array.isArray(c.box));
    const liveOhtIds=new Set(ohts.map(c=>String(c.instance_id||"")));
    const liveSumpIds=new Set(sumps.map(c=>String(c.instance_id||"")));
    purgeSyntheticFluidHeaderRoutes();
    restoreHeaderSuppressedSumpOhtRoutes();
    if(!sumps.length||!ohts.length){
      rebuildRouteConnectionIndex();
      return;
    }
    const activePairs=[];
    const rememberPair=(sumpId,ohtId)=>{
      if(!sumpId||!ohtId||connectionPairIsDeleted(sumpId,ohtId))return;
      if(!liveSumpIds.has(sumpId)||!liveOhtIds.has(ohtId))return;
      activePairs.push({sumpId,ohtId});
    };
    Object.values(routes).forEach(route=>{
      if(!route||route.hidden)return;
      const source=String(route.source||"");
      const target=String(route.target||"");
      const edgeId=String(route.edge_id||"");
      if(
        edgeId.startsWith("fluid_header_")||
        edgeId.startsWith("fluid_oht_inline_dock__")||
        edgeId.startsWith("fluid_bore_sump__")
      )return;
      if(
        (source.startsWith("sump_")&&target.startsWith("oht_"))||
        (source.startsWith("oht_")&&target.startsWith("sump_"))
      ){
        rememberPair(
          source.startsWith("sump_")?source:target,
          source.startsWith("oht_")?source:target
        );
      }
    });
    if(!activePairs.length){
      rebuildRouteConnectionIndex();
      return;
    }
    const unique=new Map();
    activePairs.forEach(pair=>{
      unique.set(`${pair.sumpId}|${pair.ohtId}`,pair);
    });
    const pairs=[...unique.values()];
    let headerY=sharedWaterHeaderY();
    if(headerY==null){
      rebuildRouteConnectionIndex();
      return;
    }
    const expandedHeader=Number(window.__ohtInlineDropHeaderY);
    if(Number.isFinite(expandedHeader)){
      headerY=Math.min(Number(headerY),Math.max(0.12,expandedHeader));
    }
    const minSpan=0.08;
    pairs.forEach(({sumpId,ohtId})=>{
      const sump=components[sumpId];
      const tank=components[ohtId];
      if(!sump||!tank||!Array.isArray(sump.box)||!Array.isArray(tank.box))return;
      const path=classicSumpOhtHeaderPath(sump.box, tank.box, headerY);
      if(!path||path.length<4)return;
      const spanHeader=Math.abs(path[1][1]-path[0][1]);
      const spanDrop=Math.abs(path[3][1]-path[2][1]);
      const spanTrunk=Math.abs(path[2][0]-path[1][0]);
      if(spanHeader+spanDrop+spanTrunk<minSpan)return;
      // Update the existing Sump↔OHT edge in place — never hide it, never
      // replace it with fragmented trunk/feeder/drop synthetics.
      Object.values(routes).forEach(route=>{
        if(!route)return;
        const source=String(route.source||"");
        const target=String(route.target||"");
        const edgeId=String(route.edge_id||"");
        if(
          edgeId.startsWith("fluid_header_")||
          edgeId.startsWith("fluid_bore_sump__")
        )return;
        const isPair=(
          (source===sumpId&&target===ohtId)||
          (source===ohtId&&target===sumpId)
        );
        if(!isPair)return;
        // Preserve user-drawn / freeze-at-save coordinates.
        // Note: payload marks all water edges stored_geometry; only custom /
        // manual_drag means the polyline itself must stay verbatim.
        if(
          route.custom||
          route.manual_drag||
          String(route.mode||"")==="manual_draw"||
          String(route.mode||"")==="manual_drag"
        ){
          route.hidden=false;
          delete route.hidden_by_fluid_header;
          route.dotted=false;
          route.color="#123DBD";
          return;
        }
        route.points=clonePoints(path);
        route.original_points=clonePoints(path);
        route.hidden=false;
        delete route.hidden_by_fluid_header;
        route.dotted=false;
        route.color="#123DBD";
        route.sketch_lock=true;
        route.source=sumpId;
        route.target=ohtId;
      });
    });
    rebuildRouteConnectionIndex();
  }

  function isBoreSumpPair(sourceId,targetId){
    const source=String(sourceId||"");
    const target=String(targetId||"");
    const sourceKind=componentWaterKind(components[source]||{component:"",title:""});
    const targetKind=componentWaterKind(components[target]||{component:"",title:""});
    if(sourceKind==="bore"&&targetKind==="sump")return {boreId:source,sumpId:target};
    if(sourceKind==="sump"&&targetKind==="bore")return {boreId:target,sumpId:source};
    const byPrefix=(
      ((source.startsWith("bore_")||source.startsWith("well_"))&&target.startsWith("sump_"))||
      ((target.startsWith("bore_")||target.startsWith("well_"))&&source.startsWith("sump_"))
    );
    if(!byPrefix)return null;
    return {
      boreId:(source.startsWith("bore_")||source.startsWith("well_"))?source:target,
      sumpId:source.startsWith("sump_")?source:target
    };
  }

  function forceBoreSumpReturn(){
    const pairs=new Map();
    Object.values(routes).forEach(route=>{
      if(!route||route.hidden)return;
      const source=String(route.source||"");
      const target=String(route.target||"");
      const edgeId=String(route.edge_id||"");
      const pair=edgeId.startsWith("fluid_bore_sump__")
        ?isBoreSumpPair(source,target)||(
          (()=>{
            const parts=edgeId.split("__");
            return parts.length>=3?isBoreSumpPair(parts[1],parts[2]):null;
          })()
        )
        :isBoreSumpPair(source,target);
      if(!pair)return;
      if(connectionPairIsDeleted(pair.boreId,pair.sumpId)){
        route.hidden=true;
        return;
      }
      pairs.set(`${pair.boreId}|${pair.sumpId}`,{
        ...pair,
        keepEdgeId:edgeId.startsWith("fluid_bore_sump__")?"":edgeId
      });
    });
    // Replace only prior fluid_bore_sump__ synthetics. User/catalog bore↔sump
    // edges (manual__*, edge__*, pair__*) stay in the map and are never deleted.
    Object.keys(routes).forEach(edgeId=>{
      if(String(edgeId||"").startsWith("fluid_bore_sump__"))delete routes[edgeId];
    });
    pairs.forEach(({boreId,sumpId,keepEdgeId})=>{
      const loop=waterLoopForComponents(boreId,sumpId);
      if(!loop)return;
      if(keepEdgeId&&routes[keepEdgeId]){
        const existing=routes[keepEdgeId];
        // Freeze-at-save / manual bore↔sump polylines must not be rewritten on
        // Saved reopen or remount (was overwriting sealed X/Y-aligned routes).
        // Do not key only on stored_geometry — payload sets that for all water.
        if(
          existing&&
          (
            existing.custom||
            existing.manual_drag||
            String(existing.mode||"")==="manual_draw"||
            String(existing.mode||"")==="manual_drag"
          )
        ){
          existing.hidden=false;
          existing.dotted=false;
          existing.color="#123DBD";
          return;
        }
        // Additive geometry update in place — do not delete/recreate the edge.
        routes[keepEdgeId]={
          ...existing,
          points:clonePoints(loop),
          original_points:clonePoints(loop),
          color:"#123DBD",
          dotted:false,
          hidden:false,
          sketch_lock:true,
          fluid_bore_sump:true,
          fluid_header:false
        };
        return;
      }
      const edgeId=`fluid_bore_sump__${boreId}__${sumpId}`;
      routes[edgeId]={
        edge_id:edgeId,
        id:edgeId,
        source:boreId,
        target:sumpId,
        sourceHandle:`${boreId}:fluid`,
        targetHandle:`${sumpId}:fluid`,
        source_handle:`${boreId}:fluid`,
        target_handle:`${sumpId}:fluid`,
        points:clonePoints(loop),
        original_points:clonePoints(loop),
        color:"#123DBD",
        dotted:false,
        hidden:false,
        stored_geometry:true,
        manual_drag:false,
        sketch_lock:true,
        fluid_bore_sump:true,
        fluid_header:false,
        direction:"source_to_target",
        original_direction:"source_to_target"
      };
    });
    rebuildRouteConnectionIndex();
  }

  function purgeUnsolicitedDottedRoutes(){
    Object.keys(routes).forEach(edgeId=>{
      const route=routes[edgeId];
      if(!route)return;
      if(routePairIsWater(route)||String(edgeId).startsWith("fluid_header_")||String(edgeId).startsWith("fluid_bore_sump__")){
        route.dotted=false;
        route.color="#123DBD";
        return;
      }
      if(route.manual_drag||route.custom||String(edgeId).startsWith("manual__"))return;
      // Keep every non-hidden route Python delivered for this worksheet (Valve,
      // Flowmeter, control, and explicit sensor lines). Only inventable OHT/TX
      // stubs that never came from the server are removed.
      if(Array.isArray(argsState.routes)){
        const fromServer=argsState.routes.some(item=>
          item&&String(item.edge_id||"")===String(edgeId)&&!item.hidden
        );
        if(fromServer)return;
      }
      const source=String(route.source||"");
      const target=String(route.target||"");
      const sourceName=String(components[source]?.component||"");
      const targetName=String(components[target]?.component||"");
      const isUnsolicitedSensorStub=(
        String(edgeId).startsWith("internal_sensor_tx__")||
        (source.startsWith("oht_")&&target.startsWith("tx_"))||
        (source.startsWith("tx_")&&target.startsWith("oht_"))||
        (sourceName==="OHT Tank"&&targetName==="Transmitter")||
        (targetName==="OHT Tank"&&sourceName==="Transmitter")||
        (
          !route.sensor_transmitter&&
          (
            (source.startsWith("lls_")&&target.startsWith("tx_"))||
            (source.startsWith("tx_")&&target.startsWith("lls_"))||
            (sourceName==="Linear Level Sensor (LLS)"&&targetName==="Transmitter")||
            (targetName==="Linear Level Sensor (LLS)"&&sourceName==="Transmitter")
          )
        )
      );
      if(!isUnsolicitedSensorStub)return;
      delete routes[edgeId];
    });
    rebuildRouteConnectionIndex();
  }

  function anchorRouteEnds(route){
    if(!route||!Array.isArray(route.points)||route.points.length<2)return;
    const sourceBox=components[String(route.source||"")]?.box;
    const targetBox=components[String(route.target||"")]?.box;
    if(Array.isArray(sourceBox)&&sourceBox.length===4&&!pointOnBoxEdge(route.points[0], sourceBox)){
      const toward=route.points[1]||route.points[0];
      route.points=draftAttachEndpoint(route.points, true, boxPort(sourceBox, toward));
    }
    const targetName=String(components[String(route.target||"")]?.component||"");
    const targetTitle=String(components[String(route.target||"")]?.title||"");
    const targetIsOht=targetName==="OHT Tank"||targetTitle.startsWith("OHT")||String(route.target||"").startsWith("oht_");
    if(targetIsOht&&Array.isArray(targetBox)&&targetBox.length===4){
      route.points=draftAttachEndpoint(route.points, false, ohtTankInletPoint(targetBox));
    }else if(Array.isArray(targetBox)&&targetBox.length===4&&!pointOnBoxEdge(route.points[route.points.length-1], targetBox)){
      const toward=route.points[route.points.length-2]||route.points[route.points.length-1];
      route.points=draftAttachEndpoint(route.points, false, boxPort(targetBox, toward));
    }
  }

  function bindLoadedConnectionGeometry(){
    Object.values(routes).forEach(route=>{
      if(!route||route.hidden)return;
      const edgeId=String(route.edge_id||"");
      if(edgeId.startsWith("fluid_header_")){
        route.dotted=false;
        route.color="#123DBD";
        route.sketch_lock=true;
        anchorRouteEnds(route);
        return;
      }
      const sourceId=String(route.source||"");
      const targetId=String(route.target||"");
      const boreSump=edgeId.startsWith("fluid_bore_sump__")
        ? (isBoreSumpPair(sourceId,targetId)||null)
        : isBoreSumpPair(sourceId,targetId);
      if(boreSump||edgeId.startsWith("fluid_bore_sump__")){
        const boreId=boreSump?boreSump.boreId:sourceId;
        const sumpId=boreSump?boreSump.sumpId:targetId;
        const loop=waterLoopForComponents(boreId,sumpId);
        if(loop){
          route.points=clonePoints(loop);
          route.original_points=clonePoints(loop);
          route.source=boreId;
          route.target=sumpId;
        }
        route.dotted=false;
        route.color="#123DBD";
        route.sketch_lock=true;
        route.fluid_bore_sump=true;
        route.fluid_header=false;
        anchorRouteEnds(route);
        return;
      }
      if(
        (sourceId.startsWith("sump_")&&targetId.startsWith("oht_"))||
        (sourceId.startsWith("oht_")&&targetId.startsWith("sump_"))
      ){
        // Keep the real edge visible. Repair auto geometry to the classic
        // rise→header→drop path; never hide it for phantom cleanup.
        if(route.hidden_by_fluid_header){
          route.hidden=false;
          delete route.hidden_by_fluid_header;
        }
        route.dotted=false;
        route.color="#123DBD";
        route.sketch_lock=true;
        if(
          route.custom||
          route.manual_drag||
          String(route.mode||"")==="manual_draw"
        ){
          anchorRouteEnds(route);
          return;
        }
        const sumpId=sourceId.startsWith("sump_")?sourceId:targetId;
        const ohtId=sourceId.startsWith("oht_")?sourceId:targetId;
        const sump=components[sumpId];
        const tank=components[ohtId];
        let headerY=sharedWaterHeaderY();
        if(sump&&tank&&Array.isArray(sump.box)&&Array.isArray(tank.box)&&headerY!=null){
          const path=classicSumpOhtHeaderPath(sump.box, tank.box, headerY);
          if(path&&path.length>=4){
            route.points=clonePoints(path);
            route.original_points=clonePoints(path);
            route.source=sumpId;
            route.target=ohtId;
          }
        }
        anchorRouteEnds(route);
        return;
      }
      if(!Array.isArray(route.points)||route.points.length<2)return;
      // Only re-anchor routes Python already marked as explicit sensor↔transmitter.
      // Never invent dotted stubs from tank/transmitter geometry.
      if(route.sensor_transmitter){
        const sensorPin=nestedSensorPinForTransmitterRoute(route);
        if(sensorPin){
          route.points=draftAttachEndpoint(route.points, sensorPin.isSource, sensorPin.point);
          route.original_points=clonePoints(route.points);
          route.dotted=true;
          route.color="#000000";
          return;
        }
      }
      anchorRouteEnds(route);
      route.original_points=clonePoints(route.points);
    });
  }

  function restoreMovementDraft(){
    const key=movementDraftStorageKey();
    if(!key)return;
    let saved=null;
    try{saved=JSON.parse(sessionStorage.getItem(key)||"null");}catch(_){saved=null;}
    if(!saved||typeof saved!=="object")return;

    // Keep the current draft version and every existing movement behavior.
    // This fix only prevents a newly regenerated automatic route from being
    // combined with an older browser-local component position.
    const restoreRoutes=saved.route_draft_version==="orthogonal-candidate-v83";
    const savedRouteList=Array.isArray(saved.routes)?saved.routes:[];
    const savedRoutes=new Map(savedRouteList.map(r=>[String(r.edge_id||""),r]));
    const savedComponents=new Map((saved.components||[]).map(c=>[String(c.instance_id||""),c]));

    function savedRouteFor(route){
      const byId=savedRoutes.get(String(route.edge_id||""));
      const source=String(route.source||"");
      const target=String(route.target||"");
      const sourceName=String(components[source]?.component||"");
      const targetName=String(components[target]?.component||"");
      const names=new Set([sourceName,targetName]);
      if(names.has("Transmitter")&&names.has("Linear Level Sensor (LLS)")){
        const manual=savedRouteList.find(item=>{
          if(!item||!item.manual_drag)return false;
          const itemSource=String(item.source||"");
          const itemTarget=String(item.target||"");
          return String(item.edge_id||"")===String(route.edge_id||"")||
            (itemSource===source&&itemTarget===target)||
            (itemSource===target&&itemTarget===source);
        });
        if(manual)return manual;
      }
      if(byId)return byId;
      if(!source||!target)return null;
      return savedRouteList.find(item=>String(item.source||"")===source&&String(item.target||"")===target)||null;
    }

    // Capture the server-generated component boxes and the exact port reference
    // used by each fresh route BEFORE restoring any browser-local movement.
    const generatedBoxes=new Map(
      Object.values(components).map(c=>[String(c.instance_id||""),cloneBox(c.box)])
    );
    const generatedPortRefs=new Map();
    Object.values(routes).forEach(r=>{
      const pts=Array.isArray(r.points)?r.points:[];
      const sourceId=String(r.source||"");
      const targetId=String(r.target||"");
      generatedPortRefs.set(String(r.edge_id||""),{
        source:pts.length&&generatedBoxes.has(sourceId)
          ?draftPortReference(generatedBoxes.get(sourceId),pts[0])
          :null,
        target:pts.length&&generatedBoxes.has(targetId)
          ?draftPortReference(generatedBoxes.get(targetId),pts[pts.length-1])
          :null
      });
    });

    if(!restoreRoutes){
      // Remove the incompatible snapshot so the next drag starts from the
      // current generated diagram as one consistent component+route state.
      try{sessionStorage.removeItem(key);}catch(_){}
      return;
    }

    // A new connection adds a route. Keep every component and line the user
    // already placed, and leave only the new route on its generated path.
    // Valve/FM must restore too — skipping them made the first drop snap back
    // when Streamlit remounted before server overrides arrived.
      Object.values(components).forEach(c=>{
      if(isEmbeddedOhtSensor(c))return;
        const s=savedComponents.get(String(c.instance_id||""));
        if(!s)return;
        if(Array.isArray(s.box)&&s.box.length===4){
          c.box=cloneBox(s.box);
          if(s.user_dragged)c.__user_dragged=true;
        }
        // Prefer the locally saved Acronym Box / Icon choice over a stale
        // payload default that can appear after unrelated component deletes.
        const savedMode=String(s.display_mode||"").trim().toLowerCase();
        if(savedMode==="acronyms"||savedMode==="acronym"||savedMode==="letters"){
          c.display_mode="acronyms";
        }else if(savedMode==="icons"||savedMode==="icon"){
          c.display_mode="icons";
        }
      });
    Object.values(routes).forEach(r=>{
      if(r.stored_geometry)return;
      const s=savedRouteFor(r);
      if(!s)return;
      if(s.manual_drag)r.manual_drag=true;
      if(Array.isArray(s.points)&&s.points.length>=2){
        r.points=clonePoints(s.points);
        r.historical_points=true;
      }
    });
    savedRouteList.forEach(item=>{
      const edgeId=String(item&&item.edge_id||"");
      if(!edgeId.startsWith("internal_sensor_tx__")||routes[edgeId])return;
      // Do not invent sensor/transmitter stub lines from an old browser draft.
      // Only an explicit server-provided or Manual Draw route may create them.
      return;
    });

    // Re-anchor only automatic terminals. A dropped line keeps its saved points.
      Object.values(routes).forEach(r=>{
        if(!Array.isArray(r.points)||r.points.length<2)return;
      if(r.manual_drag||r.stored_geometry||r.historical_points)return;
        const edgeId=String(r.edge_id||"");
        const sourceId=String(r.source||"");
        const targetId=String(r.target||"");
        const sourceBox=components[sourceId]?.box;
        const targetBox=components[targetId]?.box;
      const wasSaved=!!savedRouteFor(r);
        const generatedRefs=generatedPortRefs.get(edgeId)||{};

      if(Array.isArray(sourceBox)&&sourceBox.length===4&&!dottedTransmitterUsesInternalTank(r,true)){
          const sourceRef=wasSaved
            ?draftPortReference(sourceBox,r.points[0])
            :generatedRefs.source;
          const sourcePort=draftResolvePortReference(sourceBox,sourceRef);
          if(sourcePort)r.points=draftAttachEndpoint(r.points,true,sourcePort);
        }

      if(Array.isArray(targetBox)&&targetBox.length===4&&!dottedTransmitterUsesInternalTank(r,false)){
          const last=r.points.length-1;
          const targetRef=wasSaved
            ?draftPortReference(targetBox,r.points[last])
            :generatedRefs.target;
          const targetPort=draftResolvePortReference(targetBox,targetRef);
          if(targetPort)r.points=draftAttachEndpoint(r.points,false,targetPort);
        }
      });
    bindLoadedConnectionGeometry();
  }

  function isInlinePipeSymbol(component){
    const name=String(component&&(component.component||component.title)||"").toLowerCase();
    if(name.includes("flow meter")||name.includes("flowmeter"))return true;
    return name.includes("motorized valve")||name.includes("pressure relief")||name.includes("non-return")||name.includes("non return");
  }

  function compressOrthogonalPoints(points){
    const deduped=[];
    for(const point of points){
      const current=[Number(point[0]),Number(point[1])];
      const last=deduped[deduped.length-1];
      if(!last||Math.abs(last[0]-current[0])>1e-6||Math.abs(last[1]-current[1])>1e-6)deduped.push(current);
    }
    if(deduped.length<=2)return deduped;
    const result=[deduped[0]];
    for(let index=1;index<deduped.length-1;index++){
      const previous=result[result.length-1];
      const current=deduped[index];
      const next=deduped[index+1];
      const sameX=Math.abs(previous[0]-current[0])<1e-6&&Math.abs(current[0]-next[0])<1e-6;
      const sameY=Math.abs(previous[1]-current[1])<1e-6&&Math.abs(current[1]-next[1])<1e-6;
      if(!sameX&&!sameY)result.push(current);
    }
    result.push(deduped[deduped.length-1]);
    return result;
  }

  function pullEndpointThroughSymbol(points,isSource,box){
    if(!Array.isArray(points)||points.length<2||!Array.isArray(box)||box.length!==4)return points;
    const result=clonePoints(points);
    const [x,y,w,h]=box.map(Number);
    if(!(w>0)||!(h>0))return result;
    const cx=x+w/2,cy=y+h/2;
    const endIndex=isSource?0:result.length-1;
    const prevIndex=isSource?1:result.length-2;
    const end=result[endIndex];
    const previous=result[prevIndex];
    const inside=end[0]>x+0.02&&end[0]<x+w-0.02&&end[1]>y+0.02&&end[1]<y+h-0.02;
    const dx=Math.abs(previous[0]-end[0]);
    const dy=Math.abs(previous[1]-end[1]);
    const aligned=inside||((dx>=dy?dy:dx)<0.04);
    if(aligned){
      if(dx>=dy)previous[1]=cy;
      else previous[0]=cx;
      result[prevIndex]=previous;
      result[endIndex]=[cx,cy];
      return compressOrthogonalPoints(result);
    }
    const sides=[
      ["left",Math.abs(end[0]-x)],
      ["right",Math.abs(end[0]-(x+w))],
      ["top",Math.abs(end[1]-y)],
      ["bottom",Math.abs(end[1]-(y+h))]
    ].sort((a,b)=>a[1]-b[1]);
    const side=sides[0][0];
    let face;
    if(side==="left"||side==="right"){
      face=[side==="left"?x:x+w,cy];
      previous[1]=cy;
    }else{
      face=[cx,side==="top"?y:y+h];
      previous[0]=cx;
    }
    result[prevIndex]=previous;
    if(isSource){
      result[0]=[cx,cy];
      result.splice(1,0,face);
    }else{
      result[result.length-1]=[cx,cy];
      result.splice(result.length-1,0,face);
    }
    return compressOrthogonalPoints(result);
  }

  function seatInlinePipeSymbols(){
    const targetW=0.68,targetH=0.50;
    Object.values(components).forEach(component=>{
      if(!component||component.hidden||!isInlinePipeSymbol(component)||!Array.isArray(component.box))return;
      const [x,y,w,h]=component.box.map(Number);
      const cx=x+w/2,cy=y+h/2;
      component.box=[cx-targetW/2,cy-targetH/2,targetW,targetH];
    });
    Object.values(routes).forEach(route=>{
      if(!route||route.hidden||route.manual_drag||route.stored_geometry||route.historical_points)return;
      // Seat process lines through valve/flowmeter centers even when the pair
      // was temporarily marked dotted before water classification.
      if(route.dotted&&!routePairIsWater(route))return;
      const source=components[String(route.source||"")];
      const target=components[String(route.target||"")];
      if(source&&isInlinePipeSymbol(source))route.points=pullEndpointThroughSymbol(route.points,true,source.box);
      if(target&&isInlinePipeSymbol(target))route.points=pullEndpointThroughSymbol(route.points,false,target.box);
    });
  }

  const ANNOTATION_COLORS={
    Black:"#1c1c1c",
    White:"#ffffff",
    Yellow:"#ffe56a",
    Red:"#f05b5b",
    Blue:"#7eb0ff"
  };

  let refreshWorksheetAnnotations=null;
  let applyAnnotationFormatColor=null;
  let appliedAnnotationFormatToken="";
  function mountWorksheetAnnotations(stage,cw,ch,canvasPoint,addWindowListener){
    stage.querySelectorAll("[data-annotation-layer]").forEach(node=>node.remove());
    let annotationFieldStyle=document.getElementById("annotation-field-style");
    if(!annotationFieldStyle){
      annotationFieldStyle=document.createElement("style");
      annotationFieldStyle.id="annotation-field-style";
      document.head.appendChild(annotationFieldStyle);
    }
    annotationFieldStyle.textContent="[data-annotation-title][data-placeholder]:empty:before,[data-annotation-field][data-placeholder]:empty:before{content:attr(data-placeholder);color:inherit;-webkit-text-fill-color:inherit}";
    const layer=document.createElement("div");
    layer.setAttribute("data-annotation-layer","1");
    layer.style.cssText="position:absolute;inset:0;z-index:70;pointer-events:none;overflow:hidden;";
    stage.appendChild(layer);
    const annotationColorValue=value=>{
      const raw=String(value||"").trim().toLowerCase();
      const named={black:"#1c1c1c",white:"#ffffff",yellow:"#ffe56a",red:"#f05b5b",blue:"#7eb0ff","#fff":"#ffffff","#1c1c1c":"#1c1c1c","#ffffff":"#ffffff","#ffe56a":"#ffe56a","#f05b5b":"#f05b5b","#7eb0ff":"#7eb0ff"};
      if(named[raw])return named[raw];
      const hex=raw.match(/^#([0-9a-f]{6})$/);
      if(hex)return "#"+hex[1];
      const short=raw.match(/^#([0-9a-f]{3})$/);
      if(short){const h=short[1];return "#"+h[0]+h[0]+h[1]+h[1]+h[2]+h[2];}
      const rgb=raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if(!rgb)return "";
      const channel=part=>Math.max(0,Math.min(255,parseInt(part,10))).toString(16).padStart(2,"0");
      return "#"+channel(rgb[1])+channel(rgb[2])+channel(rgb[3]);
    };
    const sanitizeAnnotationHtml=html=>{
      const template=document.createElement("template");
      template.innerHTML=String(html||"");
      const escapeText=value=>String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      const walk=node=>{
        let out="";
        node.childNodes.forEach(child=>{
          if(child.nodeType===3){out+=escapeText(child.textContent);return;}
          if(child.nodeType!==1)return;
          const tag=child.tagName.toLowerCase();
          if(tag==="br"){out+="<br>";return;}
          if(tag==="div"||tag==="p"){
            if(out&&!out.endsWith("<br>"))out+="<br>";
            out+=walk(child);
            return;
          }
          if(tag==="span"||tag==="font"){
            const declared=(child.style&&child.style.color)||child.getAttribute("color")||"";
            const color=annotationColorValue(declared);
            const inner=walk(child);
            out+=color?`<span style="color:${color}">${inner}</span>`:inner;
            return;
          }
          out+=walk(child);
        });
        return out;
      };
      return walk(template.content).slice(0,8000);
    };
    const notes=Array.isArray(argsState.annotations)?argsState.annotations:[];
    const toPercent=(value,total)=>`${(Number(value||0)/Math.max(1,total))*100}%`;

    const place=(card,note)=>{
      const x=Number(note.x)||0;
      const y=Number(note.y)||0;
      const w=Number(note.w)||2.15;
      const h=Number(note.h)||1.35;
      const rect=stage.getBoundingClientRect();
      if(x>cw*2||y>ch*2){
        const stageW=Math.max(rect.width||0,stage.offsetWidth||0,800);
        const stageH=Math.max(rect.height||0,stage.offsetHeight||0,450);
        card.style.left=`${Math.min(78,(x/stageW)*100)}%`;
        card.style.top=`${Math.min(70,(y/stageH)*100)}%`;
      }else{
        card.style.left=toPercent(x,cw);
        card.style.top=toPercent(y,ch);
      }
      card.style.width=toPercent(w,cw);
      card.style.height=toPercent(h,ch);
    };

    const payload=(note,text)=>{
      if(note&&note._swatch&&note._swatch.dataset&&note._swatch.dataset.annotationColor){
        note.color=String(note._swatch.dataset.annotationColor);
      }
      return {
        id:String(note.id||""),
        x:Number(note.x)||0,
        y:Number(note.y)||0,
        w:Number(note.w)||2.15,
        h:Number(note.h)||1.35,
        color:String(note.color||"Yellow"),
        title:String(note.title||"").slice(0,800),
        text:String(text==null?note.text||"":text)
      };
    };

    notes.forEach(raw=>{
      try{
      if(!raw||typeof raw!=="object")return;
      const noteId=raw.id==null||String(raw.id).trim()===""?"":String(raw.id).trim();
      if(!noteId)return;
      let x=Number(raw.x);
      let y=Number(raw.y);
      if(!Number.isFinite(x))x=250;
      if(!Number.isFinite(y))y=200;
      const w=Number(raw.w)>0?Number(raw.w):2.15;
      const h=Number(raw.h)>0?Number(raw.h):1.35;
      const rect=stage.getBoundingClientRect();
      const stageW=Math.max(rect.width||0,stage.offsetWidth||0,stage.clientWidth||0,640);
      const stageH=Math.max(rect.height||0,stage.offsetHeight||0,stage.clientHeight||0,420);
      if(x>Math.max(20,cw*2)||y>Math.max(20,ch*2)){
        x=Math.min(Math.max(16,x),Math.max(16,stageW-230));
        y=Math.min(Math.max(16,y),Math.max(16,stageH-148));
      }else{
        x=Math.min(Math.max(0,x),Math.max(0,cw-w));
        y=Math.min(Math.max(0,y),Math.max(0,ch-h));
      }
      const note={
        id:noteId,
        x,
        y,
        w,
        h,
        color:ANNOTATION_COLORS[raw.color]?String(raw.color):"Black",
        title:raw.title==null?"":String(raw.title),
        text:raw.text==null?"":String(raw.text)
      };
      const ink=ANNOTATION_COLORS[note.color]||"#1c1c1c";
      const card=document.createElement("div");
      card.setAttribute("data-annotation-id",note.id);
      card.dataset.annotationColor=note.color;
      note._swatch=card;
      card.style.cssText=[
        "position:absolute",
        "pointer-events:auto",
        "box-sizing:border-box",
        "display:flex",
        "flex-direction:column",
        "border:2px solid #000",
        "border-radius:8px",
        "box-shadow:none",
        // No internal scrollbar when the note is resized smaller.
        "overflow:hidden",
        "resize:none",
        "background:transparent",
        "cursor:grab",
        "touch-action:none",
        `color:${ink}`
      ].join(";");
      place(card,note);

      const header=document.createElement("div");
      header.style.cssText="flex:0 0 28px;display:flex;align-items:center;padding:0 8px;background:transparent;cursor:inherit;";
      const title=document.createElement("div");
      title.setAttribute("data-annotation-title","1");
      title.setAttribute("data-placeholder","Title");
      title.setAttribute("contenteditable","true");
      title.setAttribute("role","textbox");
      title.setAttribute("aria-label","Annotation title");
      const titleHtml=sanitizeAnnotationHtml(note.title||"");
      if(titleHtml && String(titleHtml).replace(/<[^>]+>/g,"").trim())title.innerHTML=titleHtml;
      title.style.cssText=`flex:1 1 auto;min-width:0;outline:none;background:transparent;color:${ink};font:600 13px/1.2 sans-serif;white-space:nowrap;overflow:hidden;user-select:text;cursor:text;`;
      header.appendChild(title);
      const readTitle=()=>{
        if(!String(title.textContent||"").trim())return "";
        return sanitizeAnnotationHtml(title.innerHTML).slice(0,800);
      };
      title.addEventListener("keydown",event=>{
        event.stopPropagation();
        if(event.key==="Enter")event.preventDefault();
      });
      title.addEventListener("blur",()=>{
        note.title=readTitle();
        if(!note.title)title.innerHTML="";
        emit("annotation_update",{action:"text",id:note.id,annotation:payload(note,readField())});
      });

      const field=document.createElement("div");
      field.setAttribute("data-annotation-field","1");
      field.setAttribute("data-placeholder","Enter note here...");
      field.setAttribute("contenteditable","true");
      field.setAttribute("role","textbox");
      field.setAttribute("aria-label","Annotation note");
      field.style.cssText=`flex:1 1 auto;width:100%;min-height:0;margin:0;border:0;outline:none;resize:none;background:transparent;color:${ink};font:13px/1.35 sans-serif;padding:6px 8px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow:hidden;user-select:text;cursor:text;touch-action:none;`;
      const initialHtml=sanitizeAnnotationHtml(note.text||"");
      if(initialHtml && String(initialHtml).replace(/<[^>]+>/g,"").trim())field.innerHTML=initialHtml;
      const readField=()=>sanitizeAnnotationHtml(field.innerHTML);
      field.addEventListener("focus",()=>{
        if((field.textContent||"")==="Enter note here..."||(field.textContent||"")==="Add annotation..."){
          const range=document.createRange();
          range.selectNodeContents(field);
          const selection=window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
      });

      field.addEventListener("keydown",event=>event.stopPropagation());
      field.addEventListener("blur",()=>{
        note.text=readField();
        emit("annotation_update",{action:"text",id:note.id,annotation:payload(note,note.text)});
      });
      const caretOffset=(root,node,offset)=>{
        try{
          const range=document.createRange();
          range.selectNodeContents(root);
          range.setEnd(node,offset);
          return range.toString().length;
        }catch(_){return 0;}
      };
      const rememberFormatTarget=(element,part)=>{
        const selection=window.getSelection();
        if(!selection||!selection.rangeCount)return;
        const range=selection.getRangeAt(0);
        if(!element.contains(range.startContainer))return;
        const start=caretOffset(element,range.startContainer,range.startOffset);
        const end=caretOffset(element,range.endContainer,range.endOffset);
        try{
          sessionStorage.setItem("rts:annotation-format-target",JSON.stringify({
            id:String(note.id),
            part,
            start:Math.min(start,end),
            end:Math.max(start,end)
          }));
        }catch(_){}
      };
      const bindTypingColor=element=>{
        element.addEventListener("beforeinput",event=>{
          if((event.inputType!=="insertText"&&event.inputType!=="insertCompositionText")||!event.data)return;
          // Color picker next to Add Annotation = letter/text color for newly
          // typed characters only. Never recolor the whole Annotation Box.
          const pickerName=String(argsState.annotation_format_color||"");
          const hex=ANNOTATION_COLORS[pickerName]
            || annotationColorValue(element.dataset.pendingInk)
            || ANNOTATION_COLORS.Black;
          event.preventDefault();
          const safe=String(event.data).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
          document.execCommand("insertHTML",false,`<span style="color:${hex}">${safe}</span>`);
        });
      };
      bindTypingColor(title);
      bindTypingColor(field);
      title.addEventListener("mouseup",()=>rememberFormatTarget(title,"title"));
      title.addEventListener("keyup",()=>rememberFormatTarget(title,"title"));
      field.addEventListener("mouseup",()=>rememberFormatTarget(field,"text"));
      field.addEventListener("keyup",()=>rememberFormatTarget(field,"text"));
      title.addEventListener("blur",()=>rememberFormatTarget(title,"title"));
      field.addEventListener("blur",()=>rememberFormatTarget(field,"text"));
      card._annotationNote=note;
      card._readTitle=readTitle;
      card._readField=readField;

      const readRenderedBox=()=>{
        const stageRect=stage.getBoundingClientRect();
        const cardRect=card.getBoundingClientRect();
        const width=Math.max(1,stageRect.width||stage.offsetWidth||1);
        const height=Math.max(1,stageRect.height||stage.offsetHeight||1);
        if(!cardRect.width||!cardRect.height)return;
        note.x=clamp(((cardRect.left-stageRect.left)/width)*cw,0,Math.max(0,cw-(Number(note.w)||2.15)));
        note.y=clamp(((cardRect.top-stageRect.top)/height)*ch,0,Math.max(0,ch-(Number(note.h)||1.35)));
        note.w=clamp((cardRect.width/width)*cw,1.15,Math.max(1.15,cw*0.72));
        note.h=clamp((cardRect.height/height)*ch,0.85,Math.max(0.85,ch*0.72));
      };
      const frameEdge=event=>{
        const rect=card.getBoundingClientRect();
        const localX=event.clientX-rect.left;
        const localY=event.clientY-rect.top;
        const margin=8;
        const horizontal=localX<=margin||localX>=rect.width-margin;
        const vertical=localY<=margin||localY>=rect.height-margin;
        return {
          left:localX<=margin,
          right:localX>=rect.width-margin,
          top:localY<=margin,
          bottom:localY>=rect.height-margin,
          corner:horizontal&&vertical,
          edge:(horizontal||vertical)&&!(horizontal&&vertical)
        };
      };
      const cursorForEdge=edge=>edge.corner?"nwse-resize":edge.edge?"grab":"text";
      card.addEventListener("pointermove",event=>{
        if(event.buttons)return;
        const cursor=cursorForEdge(frameEdge(event));
        card.style.cursor=cursor;
        title.style.cursor=cursor;
        field.style.cursor=cursor;
      });
      const startMove=event=>{
        if(event.button!==0)return;
        const edge=frameEdge(event);
        const onText=event.target&&event.target.closest&&event.target.closest("[data-annotation-title],[data-annotation-field]");
        if(onText&&!edge.corner&&!edge.edge)return;
        const sizing=!!edge.corner;
        if(sizing||edge.edge){
          event.preventDefault();
          event.stopPropagation();
        }
        readRenderedBox();
        const start=canvasPoint(event);
        const originX=note.x;
        const originY=note.y;
        const originW=Number(note.w)||2.15;
        const originH=Number(note.h)||1.35;
        let action="";
        const move=ev=>{
          const point=canvasPoint(ev);
          const dx=point[0]-start[0];
          const dy=point[1]-start[1];
          if(!sizing&&Math.hypot(dx,dy)<=0.03)return;
          if(!action){
            action=sizing?"resize":"move";
            card.style.cursor=sizing?cursorForEdge(edge):"grabbing";
            window.getSelection()?.removeAllRanges();
          }
          if(action==="move"){
            note.x=clamp(originX+dx,0,Math.max(0,cw-originW));
            note.y=clamp(originY+dy,0,Math.max(0,ch-originH));
          }else{
            let nextX=originX;
            let nextY=originY;
            let nextW=originW;
            let nextH=originH;
            if(edge.right)nextW=clamp(originW+dx,1.15,Math.max(1.15,cw*0.72));
            if(edge.left){
              nextW=clamp(originW-dx,1.15,Math.max(1.15,cw*0.72));
              nextX=originX+(originW-nextW);
            }
            if(edge.bottom)nextH=clamp(originH+dy,0.85,Math.max(0.85,ch*0.72));
            if(edge.top){
              nextH=clamp(originH-dy,0.85,Math.max(0.85,ch*0.72));
              nextY=originY+(originH-nextH);
            }
            note.x=clamp(nextX,0,Math.max(0,cw-nextW));
            note.y=clamp(nextY,0,Math.max(0,ch-nextH));
            note.w=nextW;
            note.h=nextH;
          }
          place(card,note);
        };
        const up=()=>{
          window.removeEventListener("pointermove",move);
          window.removeEventListener("pointerup",up);
          card.style.cursor="grab";
          if(!action)return;
          readRenderedBox();
          note.title=readTitle();
          note.text=readField();
          emit("annotation_update",{
            action,
            id:note.id,
            annotation:payload(note,note.text)
          });
        };
        addWindowListener("pointermove",move);
        addWindowListener("pointerup",up);
      };
      card.addEventListener("pointerdown",startMove);

      card.addEventListener("contextmenu",event=>{
        event.preventDefault();
        event.stopPropagation();
        closeContext();
        const menu=document.createElement("div");
        menu.className="context";
        menu.style.cssText=`position:fixed;left:${Math.min(event.clientX,window.innerWidth-140)}px;top:${Math.min(event.clientY,window.innerHeight-48)}px;z-index:10000;min-width:112px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;box-shadow:0 8px 24px rgba(15,23,42,.16);padding:4px;pointer-events:auto;`;
        const remove=document.createElement("button");
        remove.type="button";
        remove.className="danger";
        remove.textContent="Delete";
        remove.style.cssText="display:block;width:100%;text-align:left;border:0;background:transparent;padding:7px 9px;border-radius:5px;font-size:12px;cursor:pointer;color:#b42318;";
        remove.addEventListener("pointerdown",pointerEvent=>pointerEvent.stopPropagation());
        remove.addEventListener("click",clickEvent=>{
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          card.remove();
          emit("annotation_update",{action:"delete",id:String(note.id)});
          closeContext();
        });
        menu.appendChild(remove);
        document.body.appendChild(menu);
        contextMenu=menu;
      });

      card.appendChild(header);
      card.appendChild(field);
      layer.appendChild(card);
      }catch(_){}
    });
    const paintFormatRange=(element,start,end,hex)=>{
      element.dataset.pendingInk=hex;
      if(!(end>start))return;
      const nodes=[];
      const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
      while(walker.nextNode())nodes.push(walker.currentNode);
      let pos=0;
      let startNode=null;
      let startOffset=0;
      let endNode=null;
      let endOffset=0;
      for(const node of nodes){
        const len=node.textContent.length;
        if(!startNode&&start<=pos+len){
          startNode=node;
          startOffset=Math.max(0,start-pos);
        }
        if(!endNode&&end<=pos+len){
          endNode=node;
          endOffset=Math.max(0,end-pos);
          break;
        }
        pos+=len;
      }
      if(!startNode||!endNode)return;
      const range=document.createRange();
      try{
        range.setStart(startNode,Math.min(startOffset,startNode.textContent.length));
        range.setEnd(endNode,Math.min(endOffset,endNode.textContent.length));
      }catch(_){return;}
      if(range.collapsed)return;
      const span=document.createElement("span");
      span.style.color=hex;
      span.appendChild(range.extractContents());
      range.insertNode(span);
      element.innerHTML=sanitizeAnnotationHtml(element.innerHTML);
    };
    applyAnnotationFormatColor=()=>{
      const token=String(argsState.annotation_format_token??"");
      const hex=ANNOTATION_COLORS[String(argsState.annotation_format_color||"")];
      if(!appliedAnnotationFormatToken){
        try{appliedAnnotationFormatToken=sessionStorage.getItem("rts:annotation-format-applied")||"";}catch(_){}
      }
      if(!token||token==="0"||token===appliedAnnotationFormatToken||!hex)return;
      appliedAnnotationFormatToken=token;
      try{sessionStorage.setItem("rts:annotation-format-applied",token);}catch(_){}
      let saved=null;
      try{saved=JSON.parse(sessionStorage.getItem("rts:annotation-format-target")||"null");}catch(_){saved=null;}
      let card=null;
      if(saved&&saved.id!=null){
        card=layer.querySelector(`[data-annotation-id="${String(saved.id).replace(/"/g,"")}"]`);
      }
      if(!card){
        const cards=layer.querySelectorAll("[data-annotation-id]");
        card=cards.length?cards[cards.length-1]:null;
      }
      if(!card||!card._annotationNote)return;
      const note=card._annotationNote;
      // Text-color only: remember ink for the next characters / selection.
      // Do not recolor the Annotation Box or any existing unselected text.
      card.querySelectorAll("[data-annotation-title],[data-annotation-field]").forEach(element=>{
        element.dataset.pendingInk=hex;
      });
      if(saved&&Number(saved.end)>Number(saved.start)){
        const element=card.querySelector(saved.part==="title"?"[data-annotation-title]":"[data-annotation-field]");
        if(element){
          paintFormatRange(element,Number(saved.start)||0,Number(saved.end)||0,hex);
          note.title=card._readTitle();
          note.text=card._readField();
          emit("annotation_update",{action:"text",id:note.id,annotation:payload(note,note.text)});
        }
      }
    };
    applyAnnotationFormatColor();
  }

  function snapshot(){return {routes:Object.values(routes).map(r=>({...r,points:clonePoints(r.points),original_points:clonePoints(r.original_points||r.points)})),components:Object.values(components).map(c=>({...c,box:cloneBox(c.box)}))};}
  function applySnapshot(state){routes={};components={};for(const r of (state?.routes||[])){const id=String(r.edge_id||r.id||"");if(!id)continue;const source=String(r.source||"");const target=String(r.target||"");const sourceHandle=String(r.sourceHandle||r.source_handle||(source?`${source}:auto`:""));const targetHandle=String(r.targetHandle||r.target_handle||(target?`${target}:auto`:""));routes[id]={...r,edge_id:id,id,source,target,sourceHandle,targetHandle,source_handle:sourceHandle,target_handle:targetHandle,points:clonePoints(r.points),original_points:clonePoints(r.original_points||r.points),hidden:!!r.hidden};}for(const c of (state?.components||[])){const id=String(c.instance_id||"");if(id)components[id]={...c,instance_id:id,box:cloneBox(c.box),hidden:!!c.hidden};}rebuildRouteConnectionIndex();selectedEdge=null;selectedComponents.clear();renderOverlay();}
  function checkpoint(){const s=snapshot();history=history.slice(0,historyIndex+1);history.push(JSON.parse(JSON.stringify(s)));if(history.length>100)history=history.slice(-100);historyIndex=history.length-1;dirty=true;}
  function undoLocal(){if(historyIndex<=0)return;historyIndex--;applySnapshot(history[historyIndex]);dirty=historyIndex>0;}
  function redoLocal(){if(historyIndex>=history.length-1)return;historyIndex++;applySnapshot(history[historyIndex]);dirty=true;}
  function resetAllLocal(){if(!initialSnapshot)return;applySnapshot(JSON.parse(JSON.stringify(initialSnapshot)));checkpoint();}
  function duplicateIds(ids){let made=[];for(const id of ids){const src=components[id];if(!src||src.hidden)continue;const nid=`draft_${eid()}`;const b=cloneBox(src.box);b[0]+=0.30;b[1]+=0.30;components[nid]={...src,instance_id:nid,title:`${src.title||id} Copy`,box:b,hidden:false,draft_duplicate_of:id};made.push(nid);}if(made.length){selectedEdge=null;selectedComponents=new Set(made);checkpoint();renderOverlay();}}

  // Worksheet +/- performance only: update the browser view immediately before
  // sending the single required state-sync event. The server then replaces this
  // temporary visual with the exact existing generated topology.
  function optimisticWorksheetAdd(src){
    if(!argsState.drag_only||!src||src.hidden)return;
    const nid=`pending_add_${eid()}`;
    const b=cloneBox(src.box);
    const dx=Math.max(0.18,Math.min(0.35,Number(b[2]||1)*0.12));
    const dy=Math.max(0.18,Math.min(0.35,Number(b[3]||1)*0.12));
    b[0]+=dx;b[1]+=dy;
    components[nid]={...src,instance_id:nid,title:`${src.title||src.component||"Component"} Copy`,box:b,hidden:false,draft_duplicate_of:String(src.instance_id||"")};
    renderOverlay();
  }

  function optimisticWorksheetDelete(id){
    if(!argsState.drag_only)return;
    const c=components[String(id||"")];
    if(!c)return;
    c.hidden=true;
    Object.values(routes).forEach(r=>{
      if(String(r.source||"")===String(id)||String(r.target||"")===String(id))r.hidden=true;
    });
    renderOverlay();
  }
  function setHeight(force=false){const h=Math.max(1,Math.ceil(root.getBoundingClientRect().height||document.body.scrollHeight||1));if(force||h!==lastHeight){lastHeight=h;post(SET_HEIGHT,{height:h});}}
  function svgEl(name,attrs={}){const e=document.createElementNS("http://www.w3.org/2000/svg",name);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,String(v)));return e;}
  const ptsString=p=>(p||[]).map(q=>`${q[0]},${q[1]}`).join(" ");
  function snapPoint(p){return snap?[Math.round(p[0]/grid)*grid,Math.round(p[1]/grid)*grid]:[p[0],p[1]];}
  function canvasSize(){return [Number(argsState.canvas_width||1),Number(argsState.canvas_height||1)];}
  function clientToCanvas(svg,ev){const pt=svg.createSVGPoint();pt.x=ev.clientX;pt.y=ev.clientY;const m=svg.getScreenCTM();if(!m)return[0,0];const q=pt.matrixTransform(m.inverse());return[q.x,q.y];}
  function pointInBox(p,b){return b&&p[0]>=b[0]&&p[0]<=b[0]+b[2]&&p[1]>=b[1]&&p[1]<=b[1]+b[3];}
  function isPrimaryCanvasComponent(component){
    const name=String(component&&component.component||"");
    return name==="OHT Tank"||name==="Sump"||name==="Bore Well";
  }
  function componentStackLayer(component){
    if(component&&component.__oht_attached_sensor)return 1;
    if(isPrimaryCanvasComponent(component))return 0;
    return 2;
  }
  function componentAt(p,exclude=null){
    const vals=Object.values(components).filter(c=>
      c&&!c.hidden&&c.instance_id!==exclude&&pointInBox(p,c.box)
    );
    vals.sort((a,b)=>componentStackLayer(a)-componentStackLayer(b));
    return vals.length?vals[vals.length-1]:null;
  }
  function boundaryPoint(box,p){const [x,y,w,h]=box,rx=x+w,by=y+h,px=p[0],py=p[1],cx=clamp(px,x,rx),cy=clamp(py,y,by);const cand=[[Math.abs(px-x),[x,cy]],[Math.abs(px-rx),[rx,cy]],[Math.abs(py-y),[cx,y]],[Math.abs(py-by),[cx,by]]];cand.sort((a,b)=>a[0]-b[0]);return cand[0][1];}
  function sidePort(box,side){const [x,y,w,h]=box;if(side==="left")return[x,y+h/2];if(side==="right")return[x+w,y+h/2];if(side==="top")return[x+w/2,y];return[x+w/2,y+h];}

  function snapBoxToConnectedRoute(activeDrag,box,stage,cw,ch){
    const rect=stage.getBoundingClientRect();
    const threshold=Math.max(
      24/Math.max(1,rect.width)*cw,
      24/Math.max(1,rect.height)*ch
    );
    const [x,y,w,h]=cloneBox(box);
    const center=[x+(w/2),y+(h/2)];
    let best=null;

    for(const route of (activeDrag?.attachedRoutes||[])){
      const edgeId=String(route.edge_id||"");
      const points=activeDrag.routeBase?.[edgeId];
      if(!Array.isArray(points)||points.length<2)continue;

      for(let index=0;index<points.length-1;index++){
        const first=points[index];
        const second=points[index+1];
        if(!Array.isArray(first)||!Array.isArray(second))continue;
        const x1=Number(first[0]),y1=Number(first[1]);
        const x2=Number(second[0]),y2=Number(second[1]);
        const horizontal=Math.abs(x2-x1)>=Math.abs(y2-y1);
        const segmentLength=horizontal?Math.abs(x2-x1):Math.abs(y2-y1);
        if(!Number.isFinite(segmentLength)||segmentLength<1e-9)continue;

        const segmentStart=horizontal?Math.min(x1,x2):Math.min(y1,y2);
        const segmentEnd=horizontal?Math.max(x1,x2):Math.max(y1,y2);
        const projected=horizontal?center[0]:center[1];
        const closestAlong=clamp(projected,segmentStart,segmentEnd);
        const axisValue=horizontal?y1:x1;
        const distance=horizontal
          ?Math.abs(center[1]-axisValue)
          :Math.abs(center[0]-axisValue);
        const distanceAlong=Math.abs(projected-closestAlong);
        if(distance>threshold||distanceAlong>threshold)continue;

        const snappedCenter=horizontal
          ?[closestAlong,axisValue]
          :[axisValue,closestAlong];
        const snapped=[
          clamp(snappedCenter[0]-(w/2),0,Math.max(0,cw-w)),
          clamp(snappedCenter[1]-(h/2),0,Math.max(0,ch-h)),
          w,
          h
        ];
        const score=distance+distanceAlong;
        if(!best||score<best.score)best={score,box:snapped};
      }
    }

    // When no connected route is the closer alignment target, snap the dragged
    // component center to nearby fixed component centers on either axis. This
    // changes only the live box position; dimensions and route data stay intact.
    let alignedBox=best?best.box:box;
    let alignedScore=best?best.score:Infinity;
    const dragged=components[String(activeDrag?.id||"")];
    const draggingPrimary=isPrimaryCanvasComponent(dragged);
    for(const candidate of Object.values(components)){
      if(!candidate||candidate.hidden||String(candidate.instance_id||"")===String(activeDrag?.id||""))continue;
      if(candidate.__oht_attached_sensor)continue;
      // A secondary card must not lock onto the OHT, Sump, or Bore Well center.
      if(!draggingPrimary&&isPrimaryCanvasComponent(candidate))continue;
      const [cx,cy,cwBox,chBox]=cloneBox(candidate.box);
      const candidateCenter=[cx+(cwBox/2),cy+(chBox/2)];
      const xDistance=Math.abs(center[0]-candidateCenter[0]);
      const yDistance=Math.abs(center[1]-candidateCenter[1]);
      const snapX=xDistance<=threshold;
      const snapY=yDistance<=threshold;
      if(!snapX&&!snapY)continue;

      const snappedCenter=[
        snapX?candidateCenter[0]:center[0],
        snapY?candidateCenter[1]:center[1]
      ];
      const score=(snapX?xDistance:0)+(snapY?yDistance:0);
      if(score>=alignedScore)continue;
      alignedScore=score;
      alignedBox=[
        clamp(snappedCenter[0]-(w/2),0,Math.max(0,cw-w)),
        clamp(snappedCenter[1]-(h/2),0,Math.max(0,ch-h)),
        w,
        h
      ];
    }
    if(!draggingPrimary){
      const cx=alignedBox[0]+alignedBox[2]/2;
      const cy=alignedBox[1]+alignedBox[3]/2;
      const covered=Object.values(components).some(candidate=>
        isPrimaryCanvasComponent(candidate)&&
        !candidate.hidden&&
        pointInBox([cx,cy],candidate.box)
      );
      if(covered)return box;
    }
    return alignedBox;
  }

  // TypeScript routing integration only. The existing editor remains plain JS;
  // routing.ts is compiled to routing.js and exposes window.RTSRouting. If the
  // helper is unavailable for any reason, the exact previous midpoint route is
  // returned so no existing editor functionality is lost.
  function routeNewConnectionWithTypeScript(svg,sourceId,targetId,sourcePoint,targetPoint){
    const sp=[Number(sourcePoint[0]),Number(sourcePoint[1])];
    const tp=[Number(targetPoint[0]),Number(targetPoint[1])];
    const mx=(sp[0]+tp[0])/2;
    const fallback=[sp,[mx,sp[1]],[mx,tp[1]],tp];

    const router=window.RTSRouting&&window.RTSRouting.calculateOrthogonalPath;
    if(typeof router!=="function")return fallback;

    try{
      const sourceBox=components[String(sourceId||"")]?.box;
      const targetBox=components[String(targetId||"")]?.box;
      const sourceRef=draftPortReference(sourceBox,sp);
      const targetRef=draftPortReference(targetBox,tp);

      // Convert the requested 20px port stub and 12px parallel gap into the
      // SVG's current diagram-coordinate system. This keeps the TypeScript
      // router pixel-accurate without changing existing canvas dimensions.
      const ctm=svg&&typeof svg.getScreenCTM==="function"?svg.getScreenCTM():null;
      const sx=ctm?Math.abs(Number(ctm.a)||0):0;
      const sy=ctm?Math.abs(Number(ctm.d)||0):0;
      const pixelsPerUnit=Math.max(1e-9,Math.min(
        sx>1e-9?sx:Number.POSITIVE_INFINITY,
        sy>1e-9?sy:Number.POSITIVE_INFINITY
      ));
      const pxToUnits=Number.isFinite(pixelsPerUnit)?1/pixelsPerUnit:0.01;

      const existingLines=Object.values(routes)
        .filter(route=>route&&!route.hidden&&Array.isArray(route.points)&&route.points.length>=2)
        .map(route=>route.points.map(point=>({
          x:Number(point[0]),
          y:Number(point[1])
        })));

      const routed=router(
        sp[0],sp[1],tp[0],tp[1],existingLines,{
          padding:20*pxToUnits,
          parallelGap:12*pxToUnits,
          maxShiftAttempts:24,
          sourceSide:sourceRef?.side,
          targetSide:targetRef?.side
        }
      );

      if(!Array.isArray(routed)||routed.length<2)return fallback;
      const points=routed.map(point=>[Number(point.x),Number(point.y)]);
      if(points.some(point=>!Number.isFinite(point[0])||!Number.isFinite(point[1])))return fallback;
      return points;
    }catch(_){
      return fallback;
    }
  }
  function nearestSegment(points,p){let bi=0,bd=Infinity,bp=p;for(let i=0;i<points.length-1;i++){const a=points[i],b=points[i+1],vx=b[0]-a[0],vy=b[1]-a[1],l=vx*vx+vy*vy||1;let t=((p[0]-a[0])*vx+(p[1]-a[1])*vy)/l;t=clamp(t,0,1);const q=[a[0]+t*vx,a[1]+t*vy],d=(q[0]-p[0])**2+(q[1]-p[1])**2;if(d<bd){bd=d;bi=i;bp=q;}}return{index:bi,point:bp};}
  function addWaypoint(r,seg,p){const idx=clamp(seg+1,1,r.points.length-1);r.points.splice(idx,0,snapPoint(p));return idx;}
  function removeWaypoint(r,idx){if(!r||idx<=0||idx>=r.points.length-1)return false;r.points.splice(idx,1);return true;}
  function rebuildRouteConnectionIndex(){
    routeIdsByComponent=new Map();
    for(const r of Object.values(routes)){
      if(!r)continue;
      const edgeId=String(r.edge_id||"");
      if(!edgeId)continue;
      const source=String(r.source||"");
      const target=String(r.target||"");
      for(const id of [source,target]){
        if(!id)continue;
        if(!routeIdsByComponent.has(id))routeIdsByComponent.set(id,new Set());
        routeIdsByComponent.get(id).add(edgeId);
      }
    }
  }
  function connectedRoutes(id){
    const componentId=String(id||"");
    const edgeIds=routeIdsByComponent.get(componentId);
    if(!edgeIds)return[];
    const out=[];
    for(const edgeId of edgeIds){
      const r=routes[edgeId];
      if(r&&!r.hidden&&(String(r.source||"")===componentId||String(r.target||"")===componentId))out.push(r);
    }
    return out;
  }

  // OHT Tank visual attachment only. The LLS reached through the existing
  // OHT Tank -> Transmitter -> LLS relationship is displayed on the tank body.
  // No project topology or server-side component state is changed here.
  function ohtAttachedSensorBox(parentBox){
    const [x,y,w,h]=cloneBox(parentBox);
    return [x+(w*0.38),y+(h*0.16),w*0.42,h*0.42];
  }

  function revealInternalSensorGlyph(img){
    const paint=()=>{
      try{
        const width=img.naturalWidth||0;
        const height=img.naturalHeight||0;
        if(!width||!height)return;
        const canvas=document.createElement("canvas");
        canvas.width=width;
        canvas.height=height;
        const context=canvas.getContext("2d",{willReadFrequently:true});
        if(!context)return;
        context.drawImage(img,0,0,width,height);
        const frame=context.getImageData(0,0,width,height);
        const pixels=frame.data;
        for(let index=0;index<pixels.length;index+=4){
          if(pixels[index]<36&&pixels[index+1]<36&&pixels[index+2]<36){
            pixels[index+3]=0;
          }
        }
        context.putImageData(frame,0,0);
        img.src=canvas.toDataURL("image/png");
      }catch(_){}
    };
    if(img.complete&&img.naturalWidth)paint();
    else img.addEventListener("load",paint,{once:true});
  }

  function sensorAnchorPoint(box){
    const [x,y,w,h]=cloneBox(box);
    return [x+(w/2),y+(h/2)];
  }

  function reanchorComponentRoutes(instanceId,fromBox,toBox){
    const componentId=String(instanceId||"");
    if(!componentId)return;
    for(const route of connectedRoutes(componentId)){
      if(!Array.isArray(route.points)||route.points.length<2)continue;
      const isSource=String(route.source||"")===componentId;
      const endpoint=isSource?route.points[0]:route.points[route.points.length-1];
      const symbol=components[componentId];
      if(symbol&&isInlinePipeSymbol(symbol)&&!route.dotted&&!route.manual_drag&&Array.isArray(toBox)&&toBox.length===4){
        route.points=pullEndpointThroughSymbol(route.points,isSource,toBox);
        continue;
      }
      const portRef=draftPortReference(fromBox,endpoint);
      const portPoint=draftResolvePortReference(toBox,portRef);
      if(portPoint)route.points=draftAttachEndpoint(route.points,isSource,portPoint);
    }
  }

  function attachEndpointToPoint(route,isSource,point){
    if(!route||!Array.isArray(route.points)||route.points.length<2||!point)return;
    const endpoint=isSource?route.points[0]:route.points[route.points.length-1];
    const gap=Math.hypot(Number(endpoint[0])-point[0],Number(endpoint[1])-point[1]);
    if(gap<=0.02)return;
    route.points=draftAttachEndpoint(route.points,isSource,point);
  }

  function attachSensorLinksToLivePoint(sensorId,sensorBox){
    const id=String(sensorId||"");
    const point=sensorAnchorPoint(sensorBox);
    if(!id||!point)return;
    for(const route of connectedRoutes(id)){
      if(route&&route.manual_drag)continue;
      const isSource=String(route.source||"")===id;
      const isTarget=String(route.target||"")===id;
      if(!isSource&&!isTarget)continue;
      attachEndpointToPoint(route,isSource,point);
    }
  }

  function attachOhtTransmitterToInternalSensor(tankId,sensorBox){
    const point=sensorAnchorPoint(sensorBox);
    const tank=String(tankId||"");
    if(!tank||!point)return;
    for(const route of connectedRoutes(tank)){
      if(!route||!route.dotted||route.manual_drag)continue;
      const source=String(route.source||"");
      const target=String(route.target||"");
      const other=source===tank?target:source;
      if(String(components[other]?.component||"")!=="Transmitter")continue;
      attachEndpointToPoint(route,source===tank,point);
    }
  }

  function internalSensorForTank(tankId){
    const tank=String(tankId||"");
    return Object.values(components).find(component=>
      component &&
      !component.hidden &&
      component.__oht_attached_sensor &&
      String(component.__oht_parent_id||"")===tank &&
      Array.isArray(component.box)
    )||null;
  }

  function sensorDrawnInsideTank(tankId){
    const flagged=internalSensorForTank(tankId);
    if(flagged)return flagged;
    const embeds=Array.isArray(argsState.oht_sensor_embeds)?argsState.oht_sensor_embeds:[];
    const match=embeds.find(item=>String(item&&item.tank_id||"")===String(tankId||""));
    if(match&&components[String(match.sensor_id||"")])return components[String(match.sensor_id||"")];
    const tank=components[String(tankId||"")];
    if(!tank||!Array.isArray(tank.box)||tank.box.length<4)return null;
    const [tx,ty,tw,th]=tank.box.map(Number);
    return Object.values(components).find(component=>{
      if(!component||component.hidden)return false;
      if(String(component.component||"")!=="Linear Level Sensor (LLS)")return false;
      if(!Array.isArray(component.box)||component.box.length<4)return false;
      const [x,y,w,h]=component.box.map(Number);
      const cx=x+w/2, cy=y+h/2;
      return cx>=tx&&cx<=tx+tw&&cy>=ty&&cy<=ty+th;
    })||null;
  }

  function nestedSensorPinForTransmitterRoute(route){
    if(!route)return null;
    const sourceId=String(route.source||"");
    const targetId=String(route.target||"");
    const sourceName=String(components[sourceId]?.component||"");
    const targetName=String(components[targetId]?.component||"");
    let tankId="";
    let sensorId="";
    let tankIsSource=false;
    if(sourceName==="OHT Tank"&&targetName==="Transmitter"){
      tankId=sourceId;
      tankIsSource=true;
    }else if(targetName==="OHT Tank"&&sourceName==="Transmitter"){
      tankId=targetId;
    }else if(sourceName==="Linear Level Sensor (LLS)"&&targetName==="Transmitter"){
      sensorId=sourceId;
      tankIsSource=true;
    }else if(targetName==="Linear Level Sensor (LLS)"&&sourceName==="Transmitter"){
      sensorId=targetId;
    }else if(route.sensor_transmitter){
      sensorId=sourceName==="Transmitter"?targetId:sourceId;
      tankIsSource=sensorId===sourceId;
    }else{
      return null;
    }
    let sensor=sensorId?components[sensorId]:sensorDrawnInsideTank(tankId);
    if(!sensor&&tankId)sensor=sensorDrawnInsideTank(tankId);
    if(!sensor)return null;
    const tank=components[String(sensor.__oht_parent_id||tankId||"")];
    const sensorBox=(sensor.__oht_attached_sensor||tank)&&Array.isArray(tank?.box)
      ?ohtAttachedSensorBox(tank.box)
      :sensor.box;
    if(!Array.isArray(sensorBox)||sensorBox.length<4)return null;
    return {isSource:tankIsSource||sensorId===sourceId, point:sensorAnchorPoint(sensorBox)};
  }

  function forceDottedOhtTransmitterOntoSensor(){
    // Do not invent sensor stubs from tank↔transmitter lines.
    Object.values(routes).forEach(route=>{
      if(!route||route.hidden)return;
      const source=String(route.source||"");
      const target=String(route.target||"");
      const sourceName=String(components[source]?.component||"");
      const targetName=String(components[target]?.component||"");
      if(
        (sourceName==="OHT Tank"&&targetName==="Transmitter")||
        (targetName==="OHT Tank"&&sourceName==="Transmitter")
      ){
        route.hidden=true;
      }
    });
  }

  function prepareOhtTankSensorAttachments(){
    Object.values(components).forEach(component=>{
      if(!component)return;
      delete component.__oht_attached_sensor;
      delete component.__oht_parent_id;
    });
  }

  function isEmbeddedOhtSensor(component){
    if(!component)return false;
    if(component.__oht_attached_sensor)return true;
    const sensorId=String(component.instance_id||"");
    const embeds=Array.isArray(argsState.oht_sensor_embeds)?argsState.oht_sensor_embeds:[];
    return embeds.some(item=>String(item&&item.sensor_id||"")===sensorId);
  }

  function applyClickedOhtSensorEmbeds(){
    const embeds=Array.isArray(argsState.oht_sensor_embeds)?argsState.oht_sensor_embeds:[];
    embeds.forEach(item=>{
      const tankId=String(item&&item.tank_id||"");
      const sensorId=String(item&&item.sensor_id||"");
      const tank=components[tankId];
      const sensor=components[sensorId];
      if(!tank||!sensor||tank.hidden||!Array.isArray(tank.box))return;
      sensor.hidden=false;
      sensor.__oht_attached_sensor=true;
      sensor.__oht_parent_id=tankId;
      sensor.box=ohtAttachedSensorBox(tank.box);
      attachSensorLinksToLivePoint(sensorId,sensor.box);
    });
    hideEmbeddedOhtSensorRoutes();
    anchorInternalSensorTransmitterLines();
  }

  function routeLinksEmbeddedOhtSensor(route){
    if(!route)return false;
    const embeds=Array.isArray(argsState.oht_sensor_embeds)?argsState.oht_sensor_embeds:[];
    const source=String(route.source||"");
    const target=String(route.target||"");
    const tokens=String(route.edge_id||"").split("__");
    return embeds.some(item=>{
      const tank=String(item&&item.tank_id||"");
      const sensor=String(item&&item.sensor_id||"");
      if(!tank||!sensor)return false;
      if((source===tank&&target===sensor)||(source===sensor&&target===tank))return true;
      return tokens.includes(tank)&&tokens.includes(sensor);
    });
  }

  function hideEmbeddedOhtSensorRoutes(){
    Object.values(routes).forEach(route=>{
      if(routeLinksEmbeddedOhtSensor(route))route.hidden=true;
    });
  }

  function sensorTransmitterElbow(sensorBox,transmitterBox){
    const start=sensorAnchorPoint(sensorBox);
    const [x,y,w,h]=transmitterBox.map(Number);
    const center=[x+w/2,y+h/2];
    const end=Math.abs(start[0]-center[0])>=Math.abs(start[1]-center[1])
      ?[start[0]>=center[0]?x+w:x,center[1]]
      :[center[0],start[1]>=center[1]?y+h:y];
    if(Math.abs(end[0]-start[0])>=Math.abs(end[1]-start[1])){
      const bend=(start[0]+end[0])/2;
      return [start,[bend,start[1]],[bend,end[1]],end];
    }
    const bend=(start[1]+end[1])/2;
    return [start,[start[0],bend],[end[0],bend],end];
  }

  function embeddedSensorTransmitterPairs(){
    const embeds=Array.isArray(argsState.oht_sensor_embeds)?argsState.oht_sensor_embeds:[];
    const transmitters=Object.values(components).filter(component=>
      component&&!component.hidden&&String(component.component||"")==="Transmitter"&&Array.isArray(component.box)
    );
    const pairs=[];
    embeds.forEach(item=>{
      const tank=components[String(item&&item.tank_id||"")];
      const sensor=components[String(item&&item.sensor_id||"")];
      if(!tank||!sensor||tank.hidden||sensor.hidden||!Array.isArray(sensor.box))return;
      transmitters.forEach(transmitter=>pairs.push({tank,sensor,transmitter}));
    });
    return pairs;
  }

  function routeJoins(route,firstId,secondId){
    const ends=new Set([String(route&&route.source||""),String(route&&route.target||"")]);
    return ends.has(String(firstId))&&ends.has(String(secondId));
  }

  function deletedConnectionPairSet(){
    return new Set(
      (Array.isArray(argsState.deleted_connection_pairs)?argsState.deleted_connection_pairs:[])
        .map(value=>String(value||"").trim())
        .filter(Boolean)
    );
  }

  function sortedConnectionPairKey(sourceId,targetId){
    const ends=[String(sourceId||"").trim(),String(targetId||"").trim()].filter(Boolean).sort();
    if(ends.length!==2||ends[0]===ends[1])return "";
    return `${ends[0]}|${ends[1]}`;
  }

  function connectionPairIsDeleted(sourceId,targetId){
    const pair=sortedConnectionPairKey(sourceId,targetId);
    return !!pair&&deletedConnectionPairSet().has(pair);
  }

  function stripRouteFromMovementDraft(edgeId,sourceId,targetId){
    const key=movementDraftStorageKey();
    if(!key)return;
    try{
      const saved=JSON.parse(sessionStorage.getItem(key)||"null");
      if(!saved||typeof saved!=="object"||!Array.isArray(saved.routes))return;
      const id=String(edgeId||"");
      // Exact edge-id match only — never cascade-remove sibling routes by pair.
      saved.routes=saved.routes.filter(item=>{
        if(!item)return false;
        const itemId=String(item.edge_id||item.id||"");
        return !(id&&itemId===id);
      });
      saved.route_draft_version="orthogonal-candidate-v83";
      sessionStorage.setItem(key,JSON.stringify(saved));
    }catch(_){}
  }

  function emitConnectionDelete(edgeId,sourceId,targetId){
    const id=String(edgeId||"");
    const route=routes[id]||{};
    emit("connection_delete",{
      edge_id:id,
      source:String(sourceId||route.source||""),
      target:String(targetId||route.target||"")
    });
  }

  function permanentlyRemoveRoute(edgeId){
    // Strict deletion scoping: only the exact edge id is removed.
    const id=String(edgeId||"");
    const route=routes[id];
    if(!route)return null;
    const source=String(route.source||"");
    const target=String(route.target||"");
    delete routes[id];
    stripRouteFromMovementDraft(id,source,target);
    if(selectedEdge===id)selectedEdge=null;
    rebuildRouteConnectionIndex();
    return {edge_id:id,source,target};
  }

  function seedInternalSensorTransmitterLines(){
    // Global guardrail: never invent sensor/transmitter dotted stubs on the client.
  }

  function anchorInternalSensorTransmitterLines(){
    embeddedSensorTransmitterPairs().forEach(({tank,sensor,transmitter})=>{
      const sensorId=String(sensor.instance_id||"");
      const transmitterId=String(transmitter.instance_id||"");
      const tankId=String(tank.instance_id||"");
      Object.values(routes).forEach(route=>{
        if(!route)return;
        if(routeJoins(route,tankId,transmitterId)){
          route.hidden=true;
          return;
        }
        if(!routeJoins(route,sensorId,transmitterId))return;
        if(!(route.sensor_transmitter||route.manual_drag)){
          route.hidden=true;
          return;
        }
        route.dotted=true;
        route.color="#000000";
        const pin=sensorAnchorPoint(sensor.box);
        const sensorIsSource=String(route.source||"")!==transmitterId;
        attachEndpointToPoint(route,sensorIsSource,pin);
      });
    });
    rebuildRouteConnectionIndex();
  }

  function seatInlineDevicesOnOhtDrops(){
    // User-triggered only: dock MV/FM onto an OHT drop after an explicit
    // Valve/Flowmeter ↔ OHT connection exists (Connect panel or click pair).
    const assignments=new Map();
    // Server-authored dock tags survive fluid-header rebuilds that strip
    // the temporary Valve/FM ↔ OHT edge objects from the route map.
    Object.values(components).forEach(component=>{
      if(!component||component.hidden)return;
      const deviceId=String(component.instance_id||"");
      const tankId=String(component.oht_drop_tank_id||"");
      const role=hydraulicRoleOf(component);
      if(!deviceId||!tankId.startsWith("oht_")||(role!=="fm"&&role!=="mv"))return;
      if(connectionPairIsDeleted(deviceId,tankId))return;
      assignments.set(deviceId,tankId);
    });
    Object.values(routes).forEach(route=>{
      if(!route||route.hidden)return;
      const source=String(route.source||"");
      const target=String(route.target||"");
      if(connectionPairIsDeleted(source,target))return;
      const sourceComp=components[source];
      const targetComp=components[target];
      if(!sourceComp||!targetComp)return;
      if(target.startsWith("oht_")&&(hydraulicRoleOf(sourceComp)==="mv"||hydraulicRoleOf(sourceComp)==="fm")){
        assignments.set(source,target);
        sourceComp.oht_drop_tank_id=target;
      }else if(source.startsWith("oht_")&&(hydraulicRoleOf(targetComp)==="mv"||hydraulicRoleOf(targetComp)==="fm")){
        assignments.set(target,source);
        targetComp.oht_drop_tank_id=source;
      }
    });
    // Preserve in-session docks when a later header rebuild removed route edges.
    explicitOhtInlineAssignments.forEach((tankId,deviceId)=>{
      if(assignments.has(deviceId))return;
      if(!components[deviceId]||!components[tankId]||connectionPairIsDeleted(deviceId,tankId))return;
      assignments.set(deviceId,tankId);
      if(components[deviceId])components[deviceId].oht_drop_tank_id=tankId;
    });
    [...assignments.entries()].forEach(([deviceId,tankId])=>{
      if(!components[deviceId]||!components[tankId]||connectionPairIsDeleted(deviceId,tankId)){
        assignments.delete(deviceId);
      }
    });
    explicitOhtInlineAssignments=assignments;
    if(!assignments.size)return;

    // Group every docked Valve and Flowmeter by tank, then apply one shared
    // even-spacing / dynamic-drop layout to both component types.
    const byTank=new Map();
    assignments.forEach((tankId,deviceId)=>{
      const device=components[deviceId];
      const tank=components[tankId];
      if(!device||!tank||!Array.isArray(device.box)||!Array.isArray(tank.box))return;
      const role=hydraulicRoleOf(device);
      if(role!=="fm"&&role!=="mv")return;
      const list=byTank.get(tankId)||[];
      const rawWidth=Math.max(0.01,Number(device.box[2]));
      const rawHeight=Math.max(0.01,Number(device.box[3]));
      const minimumScale=Math.max(0.42/rawWidth,0.32/rawHeight);
      const maximumScale=Math.min(0.62/rawWidth,0.46/rawHeight);
      let scale=Math.min(1,maximumScale);
      if(minimumScale<=maximumScale)scale=Math.max(minimumScale,scale);
      list.push({
        deviceId,
        role,
        width:rawWidth*scale,
        height:rawHeight*scale,
        tank
      });
      byTank.set(tankId,list);
    });
    if(!byTank.size)return;

    let headerY=sharedWaterHeaderY();
    byTank.forEach(devices=>{
      const tank=devices[0].tank;
      const tankTop=Number(tank.box[1]);
      const count=devices.length;
      const maxH=Math.max(...devices.map(item=>item.height));
      const pad=Math.max(0.10,maxH*0.45);
      const gap=Math.max(0.08,maxH*0.28);
      let needed=(2*pad)+devices.reduce((sum,item)=>sum+item.height,0);
      if(count>1)needed+=gap*(count-1);
      needed=Math.max(needed,0.34+0.22*count);
      const neededHeader=Math.max(0.12,tankTop-needed);
      if(headerY==null)headerY=neededHeader;
      else headerY=Math.min(Number(headerY),neededHeader);
    });
    if(headerY==null)return;
    window.__ohtInlineDropHeaderY=Number(headerY);

    byTank.forEach((devices,tankId)=>{
      devices.sort((a,b)=>{
        const rank=role=>(role==="fm"?0:role==="mv"?1:9);
        return rank(a.role)-rank(b.role)||a.deviceId.localeCompare(b.deviceId);
      });
      const tank=devices[0].tank;
      const tankX=Number(tank.box[0])+Number(tank.box[2])/2;
      const tankTop=Number(tank.box[1]);
      const count=devices.length;
      const maxHeight=Math.max(...devices.map(item=>item.height));
      const pad=Math.max(0.10,maxHeight*0.45);
      const gap=Math.max(0.08,maxHeight*0.28);
      const stackHeight=devices.reduce((sum,item)=>sum+item.height,0)+gap*Math.max(0,count-1);
      const freePad=Math.max(pad,(tankTop-Number(headerY)-stackHeight)/2);
      let cursorY=Number(headerY)+freePad;
      devices.forEach(item=>{
        const centerY=cursorY+item.height/2;
        const device=components[item.deviceId];
        if(!device){cursorY+=item.height+gap;return;}
        // A Valve/FM the user already dragged must keep that box across remounts.
        // Reseating here was the first-drag snap-back for docked inline devices.
        if(device.__user_dragged){
          device.oht_drop_tank_id=tankId;
          cursorY+=item.height+gap;
          return;
        }
        device.box=[tankX-item.width/2,centerY-item.height/2,item.width,item.height];
        device.oht_drop_tank_id=tankId;
        cursorY+=item.height+gap;
      });
    });
  }

  function separateComponentsFromTanks(){
    const tanks=Object.values(components).filter(component=>
      component&&!component.hidden&&String(component.component||"")==="OHT Tank"&&Array.isArray(component.box)
    );
    if(!tanks.length)return;
    const [canvasWidth,canvasHeight]=canvasSize();
    const occupied=[];
    let moved=false;
    Object.values(components).forEach(component=>{
      if(!component||component.hidden||isPrimaryCanvasComponent(component))return;
      if(component.__oht_attached_sensor||isEmbeddedOhtSensor(component))return;
      // Keep valves/flowmeters on the OHT drop; do not exile them mid-canvas.
      if(isInlineProcessComponent(component)||isInlinePipeSymbol(component))return;
      if(!Array.isArray(component.box)||component.box.length!==4)return;
      const [x,y,w,h]=component.box.map(Number);
      if(!(w>0)||!(h>0))return;
      const center=[x+w/2,y+h/2];
      const insideTank=tanks.some(tank=>pointInBox(center,tank.box));
      const atOrigin=Math.abs(x)<0.05&&Math.abs(y)<0.05;
      if(!insideTank&&!atOrigin){
        occupied.push(component.box);
        return;
      }
      let next=component.box;
      for(let slot=0;slot<24;slot++){
        const nx=Math.min(Math.max(0.4,canvasWidth-w-0.3),4.4+(slot%3)*1.45);
        const ny=Math.min(Math.max(0.4,canvasHeight-h-0.3),3.15+Math.floor(slot/3)*1.2);
        const candidate=[nx,ny,w,h];
        const candidateCenter=[nx+w/2,ny+h/2];
        const hitsTank=tanks.some(tank=>pointInBox(candidateCenter,tank.box));
        const hitsOther=occupied.some(box=>pointInBox(candidateCenter,box));
        if(!hitsTank&&!hitsOther){
          next=candidate;
          break;
        }
      }
      component.box=next;
      occupied.push(component.box);
      moved=true;
    });
    if(moved)saveMovementDraft();
  }
  function collectRoutePayload(ids){const set=new Set(ids||[]),out=[];Object.values(routes).forEach(r=>{if(set.has(r.source)||set.has(r.target))out.push({edge_id:r.edge_id,points:clonePoints(r.points),source:r.source,target:r.target,hidden:!!r.hidden});});return out;}
  function selectEdge(id){if(!routes[id]||routes[id].hidden)return;selectedEdge=id;selectedComponents.clear();closeContext();renderOverlay();root.focus({preventScroll:true});}
  function selectComponent(id,add=false){if(!components[id]||components[id].hidden)return;selectedEdge=null;if(!add)selectedComponents.clear();if(add&&selectedComponents.has(id))selectedComponents.delete(id);else selectedComponents.add(id);closeContext();renderOverlay();root.focus({preventScroll:true});}
  function deselect(){selectedEdge=null;selectedComponents.clear();closeContext();renderOverlay();}
  function createDefs(svg){const defs=svgEl("defs");svg.appendChild(defs);}
  function currentTerminalArrowGeometry(r){
    const current=Array.isArray(r.points)&&r.points.length>=2?r.points:[];
    if(current.length<2)return null;

    // Dynamic vector orientation: use the CURRENT direction and CURRENT final
    // line segment. The arrow is therefore always a live child of the route,
    // never a cached/static graphic left behind after a component or bend moves.
    const direction=String(r.direction||r.original_direction||"source_to_target");
    if(direction==="unknown")return null;
    const isStart=direction==="target_to_source";
    const tipIndex=isStart?0:current.length-1;
    const tip=[Number(current[tipIndex]?.[0]||0),Number(current[tipIndex]?.[1]||0)];

    let previous=null;
    if(isStart){
      for(let i=1;i<current.length;i++){
        const p=[Number(current[i]?.[0]||0),Number(current[i]?.[1]||0)];
        if(Math.hypot(p[0]-tip[0],p[1]-tip[1])>1e-9){previous=p;break;}
      }
    }else{
      for(let i=current.length-2;i>=0;i--){
        const p=[Number(current[i]?.[0]||0),Number(current[i]?.[1]||0)];
        if(Math.hypot(p[0]-tip[0],p[1]-tip[1])>1e-9){previous=p;break;}
      }
    }
    if(!previous)return null;

    return {
      direction,isStart,tip,previous,
      angle:Math.atan2(tip[1]-previous[1],tip[0]-previous[0])*180/Math.PI
    };
  }

  function originalArrowPose(r){
    const geom=currentTerminalArrowGeometry(r);
    if(!geom)return null;

    // Sticky terminal anchor + live atan2 orientation. No angle is cached.
    // Every redraw reads the terminal route point and its preceding point again.
    delete r.__fixed_arrow_angle;
    delete r.__fixed_arrow_is_start;
    return {
      tip:[Number(geom.tip[0]),Number(geom.tip[1])],
      angle:Number(geom.angle)
    };
  }
  function drawFixedArrow(g,r){
    const pose=originalArrowPose(r);
    if(!pose)return;
    const a=svgEl("path",{
      d:"M 0 0 L -0.110 -0.042 L -0.110 0.042 z",
      fill:"#ff7a00",
      transform:`translate(${pose.tip[0]} ${pose.tip[1]}) rotate(${pose.angle})`,
      style:"pointer-events:none"
    });
    g.appendChild(a);
  }
  function drawRoute(g,r,selected=false){const under=svgEl("polyline",{points:ptsString(r.points),class:selected?"selected-underlay":"normal-underlay"});g.appendChild(under);const line=svgEl("polyline",{points:ptsString(r.points),class:selected?"selected-line":"normal-line",stroke:r.dotted?"#000000":"#123DBD"});if(r.dotted)line.setAttribute("stroke-dasharray",".026 .052");line.setAttribute("stroke-opacity","1");g.appendChild(line);drawFixedArrow(g,r);}
  function bindRouteHit(g,svg,r){
    const hit=svgEl("polyline",{points:ptsString(r.points),class:"hit-line"});
    // Interaction-only fuzzy target: fixed 14px transparent stroke. The actual
    // visible route remains the existing thin line drawn by drawRoute().
    hit.style.strokeWidth="14px";
    hit.style.vectorEffect="non-scaling-stroke";
    hit.style.cursor="grab";
    hit.style.touchAction="none";

    hit.addEventListener("click",e=>{e.stopPropagation();selectEdge(r.edge_id);});
    hit.addEventListener("contextmenu",e=>{
      e.preventDefault();e.stopPropagation();
      selectEdge(r.edge_id);
      openContext(e.clientX,e.clientY,"edge",r.edge_id);
    });
    hit.addEventListener("dblclick",e=>{
      e.preventDefault();e.stopPropagation();
      selectEdge(r.edge_id);
      const n=nearestSegment(r.points,clientToCanvas(svg,e));
      addWaypoint(r,n.index,n.point);
      checkpoint();
      renderOverlay();
    });
    hit.addEventListener("pointerdown",e=>{
      if(e.button!==0&&e.pointerType!=="touch"&&e.pointerType!=="pen")return;
      e.preventDefault();e.stopPropagation();
      selectEdge(r.edge_id);
      const p=clientToCanvas(svg,e),seg=nearestSegment(r.points,p).index;
      drag={
        kind:"segment",
        edgeId:r.edge_id,
        seg,
        start:p,
        base:clonePoints(r.points),
        pid:e.pointerId,
        hit
      };
      hit.style.cursor="grabbing";
      try{svg.setPointerCapture(e.pointerId);}catch(_){}
    });
    g.appendChild(hit);
  }
  function moveSegment(r,p){
    if(!drag.lastValidPoints)drag.lastValidPoints=clonePoints(drag.base);
    if(!drag.smoothedPoint)drag.smoothedPoint=[Number(drag.start[0]),Number(drag.start[1])];
    drag.edgeId=String(r.edge_id||drag.edgeId||"");
    r.points=cleanDraggedRoutePoints(
      nearestNonOverlappingDragRoute(r,drag,p)
    );
    drag.lastValidPoints=clonePoints(r.points);
  }
  function drawLineHandles(g,svg,r){
    r.points.forEach((p,i)=>{
      const end=i===0||i===r.points.length-1;
      const h=svgEl("rect",{
        x:p[0]-.07,y:p[1]-.07,width:.14,height:.14,
        rx:end?.035:.012,
        class:end?"endpoint":"waypoint"
      });

      h.addEventListener("pointerdown",e=>{
        if(e.button!==0&&e.pointerType!=="touch"&&e.pointerType!=="pen")return;
        e.preventDefault();e.stopPropagation();
        const pointer=clientToCanvas(svg,e);
        const center=[Number(p[0]),Number(p[1])];
        drag={
          kind:end?"endpoint":"waypoint",
          edgeId:r.edge_id,
          index:i,
          pid:e.pointerId,
          grabOffset:[
            center[0]-Number(pointer[0]),
            center[1]-Number(pointer[1])
          ],
          handle:h,
          restoreCursor:end?"crosshair":"move"
        };
        h.style.cursor="grabbing";
        try{svg.setPointerCapture(e.pointerId);}catch(_){}
      });

      if(!end){
        const rm=e=>{
          e.preventDefault();e.stopPropagation();
          if(removeWaypoint(r,i)){checkpoint();renderOverlay();}
        };
        h.addEventListener("dblclick",rm);
        h.addEventListener("contextmenu",rm);
      }
      g.appendChild(h);
    });

    for(let i=0;i<r.points.length-1;i++){
      const a=r.points[i],b=r.points[i+1];
      const m=[(a[0]+b[0])/2,(a[1]+b[1])/2];
      const v=svgEl("circle",{cx:m[0],cy:m[1],r:.052,class:"virtual-point"});
      v.addEventListener("pointerdown",e=>{
        if(e.button!==0&&e.pointerType!=="touch"&&e.pointerType!=="pen")return;
        e.preventDefault();e.stopPropagation();
        const pointer=clientToCanvas(svg,e);
        const idx=addWaypoint(r,i,m);
        drag={
          kind:"waypoint",
          edgeId:r.edge_id,
          index:idx,
          pid:e.pointerId,
          grabOffset:[
            Number(m[0])-Number(pointer[0]),
            Number(m[1])-Number(pointer[1])
          ],
          handle:v,
          restoreCursor:"copy"
        };
        v.style.cursor="grabbing";
        try{svg.setPointerCapture(e.pointerId);}catch(_){}
        renderOverlay();
      });
      g.appendChild(v);
    }
  }
  function drawComponent(g,svg,c){
    const [x,y,w,h]=c.box;
    const bindComponentPointer=(node)=>{
      node.addEventListener("click",e=>{e.stopPropagation();selectComponent(c.instance_id,e.shiftKey||e.ctrlKey||e.metaKey);});
      node.addEventListener("contextmenu",e=>{e.preventDefault();e.stopPropagation();if(!selectedComponents.has(c.instance_id))selectComponent(c.instance_id,false);openContext(e.clientX,e.clientY,"component",c.instance_id);});
      node.addEventListener("pointerdown",e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();if(!selectedComponents.has(c.instance_id))selectComponent(c.instance_id,e.shiftKey||e.ctrlKey||e.metaKey);const p=clientToCanvas(svg,e),ids=[...selectedComponents],boxes=Object.fromEntries(ids.map(id=>[id,cloneBox(components[id].box)])),routeBase=Object.fromEntries(Object.values(routes).map(r=>[r.edge_id,clonePoints(r.points)]));drag={kind:"components",ids,start:p,boxes,routeBase,pid:e.pointerId};try{svg.setPointerCapture(e.pointerId);}catch(_){}});
    };
    if(componentDisplayMode(c)==="acronyms"){
      const plate=svgEl("g",{class:"component-acronym-svg"});
      const rect=svgEl("rect",{x,y,width:w,height:h,fill:"#ffffff",stroke:"#0f172a","stroke-width":Math.max(0.012,Math.min(w,h)*0.06)});
      const acronymText=componentAcronymText(c);
      const svgFont=Math.max(
        0.08,
        Math.min(
          Math.min(w,h)*0.52,
          (w*0.86)/Math.max(1,acronymText.length*0.62)
        )
      );
      const label=svgEl("text",{
        x:x+w/2,y:y+h/2,
        "text-anchor":"middle","dominant-baseline":"middle",
        fill:"#0f172a",
        "font-family":"Segoe UI, Arial, sans-serif",
        "font-weight":"700",
        "font-size":svgFont
      });
      label.textContent=acronymText;
      plate.appendChild(rect);
      plate.appendChild(label);
      bindComponentPointer(plate);
      g.appendChild(plate);
      return;
    }
    const img=svgEl("image",{x,y,width:w,height:h,href:`data:image/png;base64,${c.image_b64||""}`,class:"component-image",preserveAspectRatio:"none"});
    bindComponentPointer(img);
    g.appendChild(img);
  }
  function drawSelection(g,svg,c){const [x,y,w,h]=c.box;g.appendChild(svgEl("rect",{x,y,width:w,height:h,class:"component-selection"}));if(selectedComponents.size===1){const size=.13;for(const [name,cx,cy] of [["nw",x,y],["ne",x+w,y],["sw",x,y+h],["se",x+w,y+h]]){const hnd=svgEl("rect",{x:cx-size/2,y:cy-size/2,width:size,height:size,class:`resize-handle resize-${name}`});hnd.addEventListener("pointerdown",e=>{e.preventDefault();e.stopPropagation();drag={kind:"resize",id:c.instance_id,corner:name,start:clientToCanvas(svg,e),box:cloneBox(c.box),pid:e.pointerId};try{svg.setPointerCapture(e.pointerId);}catch(_){}});g.appendChild(hnd);}for(const side of ["left","right","top","bottom"]){const p=sidePort(c.box,side),ph=svgEl("circle",{cx:p[0],cy:p[1],r:.065,class:"port-handle"});ph.addEventListener("pointerdown",e=>{e.preventDefault();e.stopPropagation();drag={kind:"newConnection",source:c.instance_id,start:p,current:p,pid:e.pointerId};try{svg.setPointerCapture(e.pointerId);}catch(_){}renderOverlay();});g.appendChild(ph);}}}
  function moveSelected(p){const dx=snapPoint([p[0]-drag.start[0],p[1]-drag.start[1]])[0],dy=snapPoint([p[0]-drag.start[0],p[1]-drag.start[1]])[1];for(const id of drag.ids){const b=drag.boxes[id];components[id].box=[b[0]+dx,b[1]+dy,b[2],b[3]];}for(const [rid,pts] of Object.entries(drag.routeBase))routes[rid].points=clonePoints(pts);for(const id of drag.ids){for(const r of connectedRoutes(id)){if(r.source===id){r.points[0][0]+=dx;r.points[0][1]+=dy;if(r.points.length>2){r.points[1][0]+=dx;r.points[1][1]+=dy;}}if(r.target===id){const n=r.points.length;r.points[n-1][0]+=dx;r.points[n-1][1]+=dy;if(n>2){r.points[n-2][0]+=dx;r.points[n-2][1]+=dy;}}}}}
  function drawGrid(g){if(!snap)return;const [w,h]=canvasSize();for(let x=0;x<=w;x+=grid)g.appendChild(svgEl("line",{x1:x,y1:0,x2:x,y2:h,class:"grid-line"}));for(let y=0;y<=h;y+=grid)g.appendChild(svgEl("line",{x1:0,y1:y,x2:w,y2:y,class:"grid-line"}));}
  function renderOverlayNow(){const svg=document.getElementById("editorSvg");if(!svg)return;const g=document.getElementById("scene");g.innerHTML="";createDefs(g);drawGrid(g);const bg=svgEl("image",{x:0,y:0,width:canvasSize()[0],height:canvasSize()[1],href:`data:image/png;base64,${argsState.image_b64||""}`,preserveAspectRatio:"none",style:"pointer-events:none"});g.appendChild(bg);Object.values(routes).forEach(r=>{if(!r.hidden)drawRoute(g,r,r.edge_id===selectedEdge);});Object.values(routes).forEach(r=>{if(!r.hidden)bindRouteHit(g,svg,r);});Object.values(components).forEach(c=>{if(!c.hidden)drawComponent(g,svg,c);});if(selectedEdge&&routes[selectedEdge]&&!routes[selectedEdge].hidden)drawLineHandles(g,svg,routes[selectedEdge]);for(const id of selectedComponents){const c=components[id];if(c&&!c.hidden)drawSelection(g,svg,c);}if(drag&&drag.kind==="marquee"){const x=Math.min(drag.start[0],drag.current[0]),y=Math.min(drag.start[1],drag.current[1]),w=Math.abs(drag.current[0]-drag.start[0]),h=Math.abs(drag.current[1]-drag.start[1]);g.appendChild(svgEl("rect",{x,y,width:w,height:h,class:"marquee"}));}if(drag&&drag.kind==="newConnection"){const a=drag.start,b=drag.current,mx=(a[0]+b[0])/2;g.appendChild(svgEl("polyline",{points:ptsString([a,[mx,a[1]],[mx,b[1]],b]),class:"connect-preview"}));}}
  function renderOverlay(){if(overlayRenderQueued)return;overlayRenderQueued=true;requestAnimationFrame(()=>{overlayRenderQueued=false;renderOverlayNow();});}
  function updateView(){const svg=document.getElementById("editorSvg");if(!svg)return;const [w,h]=canvasSize(),vw=w/zoom,vh=h/zoom;svg.setAttribute("viewBox",`${panX} ${panY} ${vw} ${vh}`);const z=document.getElementById("zoomLabel");if(z)z.textContent=`${Math.round(zoom*100)}%`;}
  function fit(){zoom=1;panX=0;panY=0;updateView();}
  function zoomBy(factor){const [w,h]=canvasSize(),oldW=w/zoom,oldH=h/zoom,cx=panX+oldW/2,cy=panY+oldH/2;zoom=clamp(zoom*factor,.35,4);const nw=w/zoom,nh=h/zoom;panX=cx-nw/2;panY=cy-nh/2;updateView();}
  function align(kind){const ids=[...selectedComponents].filter(id=>components[id]&&!components[id].hidden);if(ids.length<2)return;const boxes=ids.map(id=>components[id].box);if(kind==="h"){const cy=boxes.reduce((s,b)=>s+b[1]+b[3]/2,0)/boxes.length;ids.forEach(id=>{const b=components[id].box,dy=cy-(b[1]+b[3]/2);b[1]+=dy;connectedRoutes(id).forEach(r=>{if(r.source===id){r.points[0][1]+=dy;if(r.points.length>2)r.points[1][1]+=dy;}if(r.target===id){const n=r.points.length;r.points[n-1][1]+=dy;if(n>2)r.points[n-2][1]+=dy;}});});}else{const cx=boxes.reduce((s,b)=>s+b[0]+b[2]/2,0)/boxes.length;ids.forEach(id=>{const b=components[id].box,dx=cx-(b[0]+b[2]/2);b[0]+=dx;connectedRoutes(id).forEach(r=>{if(r.source===id){r.points[0][0]+=dx;if(r.points.length>2)r.points[1][0]+=dx;}if(r.target===id){const n=r.points.length;r.points[n-1][0]+=dx;if(n>2)r.points[n-2][0]+=dx;}});});}checkpoint();renderOverlay();}
  function emitComponentBatch(ids){checkpoint();}
  function openContext(x,y,type,id){closeContext();const menu=document.createElement("div");menu.className="context";menu.style.left=`${Math.min(x,window.innerWidth-170)}px`;menu.style.top=`${Math.min(y,window.innerHeight-180)}px`;const add=(label,fn,danger=false)=>{const b=document.createElement("button");b.type="button";b.textContent=label;if(danger)b.className="danger";b.addEventListener("click",()=>{fn();closeContext();});menu.appendChild(b);};if(type==="edge"){add("Reverse direction",()=>{const r=routes[id];r.direction=r.direction==="target_to_source"?"source_to_target":"target_to_source";checkpoint();renderOverlay();});add("Reset route",()=>{const r=routes[id];r.points=clonePoints(r.original_points||r.points);r.direction=r.original_direction||"source_to_target";r.hidden=false;checkpoint();renderOverlay();});add("Delete connection",()=>{const r=routes[id];if(!r)return;if(argsState.drag_only){const source=String(r.source||"");const target=String(r.target||"");if(dragOnlyRouteAction)dragOnlyRouteAction.remove(id);else permanentlyRemoveRoute(id);emitConnectionDelete(id,source,target);}else{permanentlyRemoveRoute(id);checkpoint();renderOverlay();}},true);}else{
      const selectedId=String(id||"");
      const selectedComp=components[selectedId];
      if(selectedComp&&componentAllowsAcronymDisplay(selectedComp)){
        const acronyms=componentDisplayMode(selectedComp)==="acronyms";
        add(acronyms?"Show graphic icon":"Show engineering acronym",()=>{
          const next=acronyms?"icons":"acronyms";
          selectedComp.display_mode=next;
          emit("component_display_mode",{
            instance_id:selectedId,
            display_mode:next,
            component:String(selectedComp.component||"")
          });
          renderOverlay();
        });
      }
      add("Duplicate",()=>duplicateIds([...selectedComponents]));
      add("Copy",()=>{clipboard=[...selectedComponents];});
      add("Delete",()=>deleteSelection(),true);
    }
    document.body.appendChild(menu);contextMenu=menu;}
  function closeContext(){if(contextMenu){contextMenu.remove();contextMenu=null;}}
  function deleteSelection(){
    if(argsState.drag_only&&dragOnlyRouteAction&&dragOnlyRouteAction.selected){
      const edgeId=dragOnlyRouteAction.selected;
      const route=routes[edgeId]||{};
      const source=String(route.source||"");
      const target=String(route.target||"");
      dragOnlyRouteAction.remove(edgeId);
      emitConnectionDelete(edgeId,source,target);
      return;
    }
    // Delete a selected connection by itself, exactly as before.
    if(selectedEdge){
      const edge=routes[selectedEdge];
      if(edge){
        const source=String(edge.source||"");
        const target=String(edge.target||"");
        if(argsState.drag_only&&dragOnlyRouteAction){
          dragOnlyRouteAction.remove(selectedEdge);
        }else{
          permanentlyRemoveRoute(selectedEdge);
        }
        if(argsState.drag_only){
          emitConnectionDelete(selectedEdge,source,target);
        }
      }
      selectedEdge=null;
      if(!argsState.drag_only){
        checkpoint();
        renderOverlay();
      }
      return;
    }

    // Delete selected component instance(s) as one edit transaction.  This works
    // for original editable components as well as components created by Duplicate/
    // Paste.  Any connection whose current source OR target is one of the deleted
    // instances is removed visually at the same time, including manual connections
    // and lines that were reconnected during this edit session.
    const ids=[...selectedComponents].filter(id=>components[id]&&!components[id].hidden);
    if(!ids.length)return;
    const deleted=new Set(ids);

    for(const id of ids){
      components[id].hidden=true;
      components[id].deleted_by_user=true;
    }

    for(const r of Object.values(routes)){
      if(deleted.has(String(r.source||""))||deleted.has(String(r.target||""))){
        r.hidden=true;
        r.deleted_with_component=true;
      }
    }

    if(selectedEdge&&routes[selectedEdge]&&routes[selectedEdge].hidden)selectedEdge=null;
    selectedComponents.clear();
    clipboard=clipboard.filter(id=>!deleted.has(id));
    checkpoint();
    renderOverlay();
  }
  function copySelection(){clipboard=[...selectedComponents];}
  function pasteSelection(){if(clipboard.length)duplicateIds(clipboard);}
  async function saveEditor(){const b=document.getElementById("saveEditorBtn");if(b){b.disabled=true;b.textContent="Saving...";}try{const image_b64=await composeEditedPng();emit("save_editor",{image_b64,routes:Object.values(routes).map(r=>({...r,points:clonePoints(r.points)})),components:Object.values(components).map(c=>({...c,box:cloneBox(c.box)})),canvas_width:canvasSize()[0],canvas_height:canvasSize()[1],viewport:{zoom:Number(zoom)||1,pan_x:Number(panX)||0,pan_y:Number(panY)||0}});}catch(err){console.error(err);alert("Could not save the edited diagram. Please try again.");if(b){b.disabled=false;b.textContent="Save";}}}
  function loadImage(src){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=src;});}
  async function composeEditedPng(){const [cw,ch]=canvasSize();const bg=await loadImage(`data:image/png;base64,${argsState.image_b64||""}`);const canvas=document.createElement("canvas");canvas.width=bg.naturalWidth||1600;canvas.height=bg.naturalHeight||900;const ctx=canvas.getContext("2d");ctx.drawImage(bg,0,0,canvas.width,canvas.height);const sx=canvas.width/cw,sy=canvas.height/ch;ctx.save();ctx.scale(sx,sy);for(const r of Object.values(routes)){if(r.hidden||!r.points?.length)continue;ctx.lineJoin="round";ctx.lineCap="round";ctx.strokeStyle="#fff";ctx.lineWidth=.030;ctx.setLineDash([]);drawCanvasPolyline(ctx,r.points);ctx.strokeStyle=r.dotted?"#000000":"#123DBD";ctx.lineWidth=.015;ctx.setLineDash(r.dotted?[.018,.095]:[]);drawCanvasPolyline(ctx,r.points);drawCanvasArrow(ctx,r);}ctx.restore();for(const c of Object.values(components)){if(c.hidden||!c.image_b64)continue;try{const img=await loadImage(`data:image/png;base64,${c.image_b64}`);const [x,y,w,h]=c.box;ctx.drawImage(img,x*sx,y*sy,w*sx,h*sy);}catch(_){}}return canvas.toDataURL("image/png").split(",")[1];}
  function drawCanvasPolyline(ctx,pts){ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0],pts[i][1]);ctx.stroke();}
  function drawCanvasArrow(ctx,r){const pose=originalArrowPose(r);if(!pose)return;const tip=pose.tip,ang=pose.angle*Math.PI/180,size=.16;ctx.save();ctx.fillStyle="#ff7a00";ctx.beginPath();ctx.moveTo(tip[0],tip[1]);ctx.lineTo(tip[0]-size*Math.cos(ang-.55),tip[1]-size*Math.sin(ang-.55));ctx.lineTo(tip[0]-size*Math.cos(ang+.55),tip[1]-size*Math.sin(ang+.55));ctx.closePath();ctx.fill();ctx.restore();}
  function renderToolbar(){const bar=document.createElement("div");bar.className="toolbar";const btn=(txt,title,fn,id)=>{const b=document.createElement("button");b.type="button";b.textContent=txt;b.title=title;b.addEventListener("click",fn);if(id)b.id=id;bar.appendChild(b);return b;};btn("↶","Undo (Ctrl+Z)",undoLocal);btn("↷","Redo (Ctrl+Y)",redoLocal);const d=()=>bar.appendChild(Object.assign(document.createElement("span"),{className:"divider"}));d();btn("Copy","Copy (Ctrl+C)",copySelection);btn("Paste","Paste (Ctrl+V)",pasteSelection);btn("Duplicate","Duplicate selected components (Ctrl+D)",()=>duplicateIds([...selectedComponents]));btn("Delete","Delete selection",deleteSelection);d();btn("−","Zoom out",()=>zoomBy(.85));const zl=document.createElement("span");zl.id="zoomLabel";zl.className="zoom-label";zl.textContent="100%";bar.appendChild(zl);btn("+","Zoom in",()=>zoomBy(1.18));btn("Fit","Fit to screen",fit);d();const sb=btn("Snap","Snap to grid",()=>{snap=!snap;sb.classList.toggle("active",snap);renderOverlay();});sb.classList.toggle("active",snap);btn("Align H","Align selected horizontally",()=>align("h"));btn("Align V","Align selected vertically",()=>align("v"));d();btn("Reset","Reset to original generated layout",()=>{if(confirm("Reset all manual diagram edits to the original generated layout?"))resetAllLocal();});d();const save=btn("Save","Save all edits to Worksheet",saveEditor,"saveEditorBtn");save.classList.add("save-button");const h=document.createElement("span");h.className="hint";h.textContent="All changes stay in Edit Mode until Save";bar.appendChild(h);return bar;}
  function finishDrag(svg,e){
    if(!drag||drag.pid!==e.pointerId)return;
    const d=drag;
    drag=null;
    try{svg.releasePointerCapture(e.pointerId);}catch(_){}
    if(d.hit)d.hit.style.cursor="grab";
    if(d.handle)d.handle.style.cursor=d.restoreCursor||"";

    if(d.kind==="segment"||d.kind==="waypoint"||d.kind==="endpoint"||d.kind==="components"||d.kind==="resize"){
      if(d.kind==="endpoint")rebuildRouteConnectionIndex();
      checkpoint();
    }else if(d.kind==="marquee"){
      const x1=Math.min(d.start[0],d.current[0]),x2=Math.max(d.start[0],d.current[0]);
      const y1=Math.min(d.start[1],d.current[1]),y2=Math.max(d.start[1],d.current[1]);
      selectedComponents.clear();
      Object.values(components).forEach(c=>{
        if(!c.hidden&&c.box[0]>=x1&&c.box[1]>=y1&&c.box[0]+c.box[2]<=x2&&c.box[1]+c.box[3]<=y2){
          selectedComponents.add(c.instance_id);
        }
      });
      renderOverlay();
    }else if(d.kind==="newConnection"){
      const target=componentAt(d.current,d.source);
      if(target){
        const sp=boundaryPoint(components[d.source].box,d.start);
        const tp=boundaryPoint(target.box,d.current);
        const pts=routeNewConnectionWithTypeScript(svg,d.source,target.instance_id,sp,tp);
        const rid=`manual_${eid()}`;
        const sourceId=String(d.source||"");
        const targetId=String(target.instance_id||"");
        routes[rid]={
          edge_id:rid,id:rid,label:"Manual connection",source:sourceId,target:targetId,
          sourceHandle:`${sourceId}:auto`,targetHandle:`${targetId}:auto`,
          source_handle:`${sourceId}:auto`,target_handle:`${targetId}:auto`,
          points:pts,original_points:clonePoints(pts),
          direction:"source_to_target",original_direction:"source_to_target",
          color:"#123DBD",dotted:false,hidden:false,custom:true
        };
        rebuildRouteConnectionIndex();
        checkpoint();
      }
      renderOverlay();
    }
  }
  function renderEditor(){
    root.innerHTML="";
    root.appendChild(renderToolbar());

    const wrap=document.createElement("div");
    wrap.className="stage-wrap";
    const [w,h]=canvasSize();
    const svg=svgEl("svg",{
      id:"editorSvg",
      viewBox:`0 0 ${w} ${h}`,
      preserveAspectRatio:"xMidYMid meet"
    });
    const scene=svgEl("g",{id:"scene"});
    svg.appendChild(scene);
    wrap.appendChild(svg);
    root.appendChild(wrap);

    const applyLinePointerMove=eventLike=>{
      if(!drag||drag.pid!==eventLike.pointerId)return;
      if(!["segment","waypoint","endpoint"].includes(drag.kind))return;

      const raw=clientToCanvas(svg,eventLike);
      const offset=Array.isArray(drag.grabOffset)?drag.grabOffset:[0,0];
      const p=[
        Number(raw[0])+Number(offset[0]||0),
        Number(raw[1])+Number(offset[1]||0)
      ];

      if(drag.kind==="segment"){
        moveSegment(routes[drag.edgeId],p);
      }else if(drag.kind==="waypoint"){
        routes[drag.edgeId].points[drag.index]=snapPoint(p);
      }else if(drag.kind==="endpoint"){
        const r=routes[drag.edgeId];
        const idx=drag.index;
        const isSource=idx===0;
        const c=componentAt(p,null);
        if(c){
          r.points[idx]=boundaryPoint(c.box,p);
          if(isSource)r.source=c.instance_id;
          else r.target=c.instance_id;
        }else{
          const box=components[isSource?r.source:r.target]?.box||(isSource?r.source_box:r.target_box);
          r.points[idx]=boundaryPoint(box,p);
        }
      }
      renderOverlay();
    };

    const linePointerQueue=createRafPointerQueue(applyLinePointerMove);

    svg.addEventListener("pointerdown",e=>{
      closeContext();
      if(e.target===svg||e.target===scene){
        const p=clientToCanvas(svg,e);
        if(e.button===1||e.altKey){
          drag={
            kind:"pan",
            startClient:[e.clientX,e.clientY],
            startPan:[panX,panY],
            pid:e.pointerId
          };
        }else{
          selectedEdge=null;
          if(!e.shiftKey)selectedComponents.clear();
          drag={kind:"marquee",start:p,current:p,pid:e.pointerId};
        }
        try{svg.setPointerCapture(e.pointerId);}catch(_){}
        renderOverlay();
      }
    });

    svg.addEventListener("pointermove",e=>{
      if(!drag||drag.pid!==e.pointerId)return;
      e.preventDefault();

      if(["segment","waypoint","endpoint"].includes(drag.kind)){
        e.stopPropagation();
        linePointerQueue.push(e);
        return;
      }

      const p=clientToCanvas(svg,e);
      if(drag.kind==="components"){
        moveSelected(p);
      }else if(drag.kind==="resize"){
        const c=components[drag.id];
        const [bx,by,bw,bh]=drag.box;
        const minW=.35,minH=.25;
        let x=bx,y=by,ww=bw,hh=bh;
        if(drag.corner.includes("e"))ww=Math.max(minW,p[0]-bx);
        if(drag.corner.includes("s"))hh=Math.max(minH,p[1]-by);
        if(drag.corner.includes("w")){
          x=Math.min(p[0],bx+bw-minW);
          ww=bx+bw-x;
        }
        if(drag.corner.includes("n")){
          y=Math.min(p[1],by+bh-minH);
          hh=by+bh-y;
        }
        c.box=[
          ...snapPoint([x,y]),
          Math.max(minW,snap?Math.round(ww/grid)*grid:ww),
          Math.max(minH,snap?Math.round(hh/grid)*grid:hh)
        ];
        connectedRoutes(c.instance_id).forEach(r=>{
          if(r.source===c.instance_id)r.points[0]=boundaryPoint(c.box,r.points[0]);
          if(r.target===c.instance_id)r.points[r.points.length-1]=boundaryPoint(c.box,r.points[r.points.length-1]);
        });
      }else if(drag.kind==="marquee"){
        drag.current=p;
      }else if(drag.kind==="newConnection"){
        drag.current=p;
      }else if(drag.kind==="pan"){
        const rect=svg.getBoundingClientRect(),vw=w/zoom,vh=h/zoom;
        panX=drag.startPan[0]-(e.clientX-drag.startClient[0])/rect.width*vw;
        panY=drag.startPan[1]-(e.clientY-drag.startClient[1])/rect.height*vh;
        updateView();
        return;
      }
      renderOverlay();
    });

    svg.addEventListener("pointerup",e=>{
      if(drag&&drag.pid===e.pointerId&&["segment","waypoint","endpoint"].includes(drag.kind)){
        linePointerQueue.flush(e);
      }
      finishDrag(svg,e);
    });

    svg.addEventListener("pointercancel",e=>{
      if(drag&&drag.pid===e.pointerId){
        linePointerQueue.cancel();
        if(drag.hit)drag.hit.style.cursor="grab";
        if(drag.handle)drag.handle.style.cursor=drag.restoreCursor||"";
        drag=null;
      }
    });

    svg.addEventListener("wheel",e=>{
      e.preventDefault();
      zoomBy(e.deltaY<0?1.12:.89);
    },{passive:false});

    renderOverlay();
    updateView();
    setHeight(true);
  }

  function renderDragOnly(){
    // Remove window-level drag listeners from the previous Worksheet render.
    // This prevents duplicate pointermove handlers from accumulating across
    // Streamlit/component rerenders.
    for(const [type,listener] of dragOnlyWindowListeners){
      window.removeEventListener(type,listener);
    }
    dragOnlyWindowListeners=[];
    const addDragOnlyWindowListener=(type,listener)=>{
      window.addEventListener(type,listener);
      dragOnlyWindowListeners.push([type,listener]);
    };

    root.innerHTML="";
    root.style.position="relative";
    root.style.width="100%";
    root.style.minHeight="1px";
    root.style.overflow="hidden";
    root.style.userSelect="none";
    root.style.touchAction="none";

    const [cw,ch]=canvasSize();

    // Keep the renderer height fixed; the stage fills this viewport regardless
    // of the logical canvas aspect ratio after a component-selection rerun.
    const rawFixedHeight=Number(argsState.fixed_screen_height);
    const hasFixedHeight=Number.isFinite(rawFixedHeight)&&rawFixedHeight>0;
    const fixedScreenHeight=hasFixedHeight?Math.max(1,rawFixedHeight):0;

    if(argsState.fit_screen){
      root.style.height=hasFixedHeight?`${fixedScreenHeight}px`:"100vh";
      root.style.minHeight="0";
      root.style.maxHeight=hasFixedHeight?`${fixedScreenHeight}px`:"100vh";
    }else{
      root.style.height="auto";
      root.style.maxHeight="none";
    }

    const stage=document.createElement("div");
    stage.style.cssText=argsState.fit_screen
      ? "position:absolute;inset:0;width:100%;height:100%;overflow:hidden;touch-action:none;user-select:none;"
      : `position:relative;width:100%;aspect-ratio:${cw}/${ch};overflow:hidden;touch-action:none;user-select:none;`;
    root.appendChild(stage);

    const bg=document.createElement("img");
    bg.src=`data:image/png;base64,${argsState.image_b64||""}`;
    bg.draggable=false;
    bg.style.cssText="position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:block;pointer-events:none;user-select:none;";
    stage.appendChild(bg);

    // Worksheet center-title direct inline editing only.
    // Double-click the existing title strip to edit the text in that exact
    // location. No popup, prompt, modal, or separate editing section is used.
    const worksheetTitleStorageKey=()=>{
      const key=String(argsState.local_draft_key||"").trim();
      return key?`rts:worksheet-title:${key}`:"rts:worksheet-title:default";
    };

    const defaultWorksheetTitle=String(
      argsState.worksheet_title ||
      "FULLY AUTOMATION - SELECTED COMPONENT AUTOMATION DIAGRAM"
    ).trim();

    let worksheetTitleText=defaultWorksheetTitle;
    let worksheetTitleEdited=false;
    let worksheetTitleEditing=false;
    let worksheetTitleBeforeEdit=worksheetTitleText;

    try{
      const stored=sessionStorage.getItem(worksheetTitleStorageKey());
      if(stored!==null){
        worksheetTitleText=String(stored);
        worksheetTitleEdited=true;
      }
    }catch(_){}

    const worksheetTitleOverlay=document.createElement("input");
    worksheetTitleOverlay.type="text";
    worksheetTitleOverlay.setAttribute("aria-label","Worksheet diagram title");
    worksheetTitleOverlay.autocomplete="off";
    worksheetTitleOverlay.spellcheck=false;
    worksheetTitleOverlay.readOnly=true;
    worksheetTitleOverlay.style.cssText=[
      "position:absolute",
      "z-index:12",
      "display:none",
      "text-align:center",
      "overflow:hidden",
      "pointer-events:none",
      "user-select:none",
      "background:#ffffff",
      "color:#173f75",
      "font-family:Arial,Segoe UI,sans-serif",
      "font-weight:700",
      "line-height:1.15",
      "padding:0 6px",
      "margin:0",
      "border:0",
      "outline:none",
      "box-shadow:none",
      "border-radius:0",
      "appearance:none",
      "-webkit-appearance:none",
      "box-sizing:border-box"
    ].join(";");
    stage.appendChild(worksheetTitleOverlay);

    const worksheetTitleHotspot=document.createElement("div");
    worksheetTitleHotspot.setAttribute(
      "aria-label",
      "Double-click to edit diagram title"
    );
    worksheetTitleHotspot.title="Double-click to edit diagram title";
    worksheetTitleHotspot.style.cssText=[
      "position:absolute",
      "z-index:70",
      "background:rgba(0,0,0,0.001)",
      "cursor:text",
      "pointer-events:auto",
      "touch-action:manipulation",
      "box-sizing:border-box"
    ].join(";");
    stage.appendChild(worksheetTitleHotspot);

    const positionWorksheetTitleEditor=()=>{
      const naturalWidth=Math.max(1,Number(bg.naturalWidth)||1);
      const naturalHeight=Math.max(1,Number(bg.naturalHeight)||1);

      // Exact existing title-strip region from the current renderer.
      const hotspotLeft=46/naturalWidth*100;
      const hotspotTop=195/naturalHeight*100;
      const hotspotWidth=(naturalWidth-92)/naturalWidth*100;
      const hotspotHeight=132/naturalHeight*100;

      worksheetTitleHotspot.style.left=`${hotspotLeft}%`;
      worksheetTitleHotspot.style.top=`${hotspotTop}%`;
      worksheetTitleHotspot.style.width=`${hotspotWidth}%`;
      worksheetTitleHotspot.style.height=`${hotspotHeight}%`;

      // Cover only the original title text line itself. The existing underline,
      // header, card border, layout and every other Worksheet pixel stay intact.
      const textLeft=82/naturalWidth*100;
      const textTop=211/naturalHeight*100;
      const textWidth=(naturalWidth-164)/naturalWidth*100;
      const textHeight=72/naturalHeight*100;

      worksheetTitleOverlay.style.left=`${textLeft}%`;
      worksheetTitleOverlay.style.top=`${textTop}%`;
      worksheetTitleOverlay.style.width=`${textWidth}%`;
      worksheetTitleOverlay.style.height=`${textHeight}%`;

      const stageRect=stage.getBoundingClientRect();
      const scaleY=stageRect.height/naturalHeight;
      worksheetTitleOverlay.style.fontSize=`${Math.max(7,36*scaleY)}px`;
      worksheetTitleOverlay.value=worksheetTitleText;

      if(worksheetTitleEditing){
        worksheetTitleOverlay.style.display="block";
      }else{
        worksheetTitleOverlay.style.display=worksheetTitleEdited?"block":"none";
      }
    };

    const worksheetTitleCaretIndexFromPoint=(clientX)=>{
      try{
        const value=String(worksheetTitleOverlay.value||"");
        if(!value)return 0;

        const rect=worksheetTitleOverlay.getBoundingClientRect();
        const computed=window.getComputedStyle(worksheetTitleOverlay);
        const canvas=document.createElement("canvas");
        const context=canvas.getContext("2d");
        if(!context)return value.length;

        context.font=[
          computed.fontStyle,
          computed.fontVariant,
          computed.fontWeight,
          computed.fontSize,
          computed.fontFamily
        ].filter(Boolean).join(" ");

        const fullWidth=context.measureText(value).width;
        const textLeft=rect.left+Math.max(0,(rect.width-fullWidth)/2);
        const localX=Math.max(0,Math.min(fullWidth,Number(clientX)-textLeft));

        let previousWidth=0;
        for(let index=1;index<=value.length;index+=1){
          const currentWidth=context.measureText(value.slice(0,index)).width;
          const midpoint=(previousWidth+currentWidth)/2;
          if(localX<=midpoint){
            return index-1;
          }
          previousWidth=currentWidth;
        }

        return value.length;
      }catch(_){
        return String(worksheetTitleOverlay.value||"").length;
      }
    };

    const placeWorksheetTitleCaretAtPoint=(clientX)=>{
      try{
        const index=worksheetTitleCaretIndexFromPoint(clientX);
        worksheetTitleOverlay.setSelectionRange(index,index);
      }catch(_){}
    };

    const finishWorksheetTitleEdit=(save=true)=>{
      if(!worksheetTitleEditing)return;

      if(save){
        const next=String(
          worksheetTitleOverlay.value||""
        ).trim();

        worksheetTitleText=next||worksheetTitleBeforeEdit||defaultWorksheetTitle;
        worksheetTitleEdited=true;

        try{
          sessionStorage.setItem(
            worksheetTitleStorageKey(),
            worksheetTitleText
          );
        }catch(_){}
      }else{
        worksheetTitleText=worksheetTitleBeforeEdit;
      }

      worksheetTitleEditing=false;
      worksheetTitleOverlay.readOnly=true;
      worksheetTitleOverlay.style.pointerEvents="none";
      worksheetTitleOverlay.style.userSelect="none";
      worksheetTitleOverlay.style.cursor="default";
      worksheetTitleOverlay.style.zIndex="12";
      worksheetTitleHotspot.style.pointerEvents="auto";

      positionWorksheetTitleEditor();
    };

    const beginWorksheetTitleEdit=(clientX=null,clientY=null)=>{
      if(worksheetTitleEditing)return;

      worksheetTitleBeforeEdit=worksheetTitleText;
      worksheetTitleEditing=true;

      worksheetTitleOverlay.value=worksheetTitleText;
      worksheetTitleOverlay.readOnly=false;
      worksheetTitleOverlay.style.display="block";
      worksheetTitleOverlay.style.pointerEvents="auto";
      worksheetTitleOverlay.style.userSelect="text";
      worksheetTitleOverlay.style.cursor="text";
      worksheetTitleOverlay.style.zIndex="80";
      worksheetTitleHotspot.style.pointerEvents="none";

      worksheetTitleOverlay.focus({preventScroll:true});

      // Real input behavior: put a collapsed caret near the user's double-click.
      // No select-all is performed, so character-by-character editing works.
      requestAnimationFrame(()=>{
        if(Number.isFinite(Number(clientX))){
          placeWorksheetTitleCaretAtPoint(Number(clientX));
        }else{
          try{
            const end=worksheetTitleOverlay.value.length;
            worksheetTitleOverlay.setSelectionRange(end,end);
          }catch(_){}
        }
      });
    };

    worksheetTitleHotspot.addEventListener("dblclick",event=>{
      event.preventDefault();
      event.stopPropagation();
      beginWorksheetTitleEdit(event.clientX,event.clientY);
    });

    worksheetTitleOverlay.addEventListener("pointerdown",event=>{
      event.stopPropagation();
    });

    worksheetTitleOverlay.addEventListener("dblclick",event=>{
      // Preserve native input double-click behavior, including word selection.
      event.stopPropagation();
    });

    worksheetTitleOverlay.addEventListener("keydown",event=>{
      if(event.key==="Enter"){
        event.preventDefault();
        event.stopPropagation();
        finishWorksheetTitleEdit(true);
        worksheetTitleOverlay.blur();
        return;
      }

      if(event.key==="Escape"){
        event.preventDefault();
        event.stopPropagation();
        finishWorksheetTitleEdit(false);
        worksheetTitleOverlay.blur();
      }
    });

    worksheetTitleOverlay.addEventListener("blur",()=>{
      if(worksheetTitleEditing){
        finishWorksheetTitleEdit(true);
      }
    });

    if(bg.complete){
      positionWorksheetTitleEditor();
    }else{
      bg.addEventListener(
        "load",
        positionWorksheetTitleEditor,
        {once:true}
      );
    }

    // Live route layer. The Worksheet background intentionally contains no
    // components/connections while drag-only mode is active.
    const routeSvg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    routeSvg.setAttribute("viewBox",`0 0 ${cw} ${ch}`);
    routeSvg.setAttribute("preserveAspectRatio","none");
    routeSvg.style.cssText="position:absolute;inset:0;width:100%;height:100%;z-index:5;pointer-events:auto;overflow:visible;";
    stage.appendChild(routeSvg);
    // The dotted OHT sensor line must paint above the tank icon and still
    // sit under the internal LLS icon, so it is visible from the sensor to
    // the transmitter. Solid lines, including Sump-to-Tank, stay below.
    const sensorRouteSvg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    sensorRouteSvg.setAttribute("viewBox",`0 0 ${cw} ${ch}`);
    sensorRouteSvg.setAttribute("preserveAspectRatio","none");
    sensorRouteSvg.style.cssText="position:absolute;inset:0;width:100%;height:100%;z-index:16;pointer-events:none;overflow:visible;";
    stage.appendChild(sensorRouteSvg);

    const routeEl=(name,attrs={})=>{
      const el=document.createElementNS("http://www.w3.org/2000/svg",name);
      for(const [k,v] of Object.entries(attrs)){
        if(v!==undefined&&v!==null)el.setAttribute(k,String(v));
      }
      return el;
    };

    let activeRouteDrag=null;
    const routeVisuals=new Map();

    // Convert a pointer position to the diagram coordinate system without
    // imposing a percentage/slider limit. Pointer capture keeps the drag alive
    // even when the pointer temporarily leaves the visible line itself.
    const rawRouteCanvasPoint=(ev)=>{
      const r=stage.getBoundingClientRect();
      if(!r.width||!r.height)return[0,0];
      return[
        (ev.clientX-r.left)/r.width*cw,
        (ev.clientY-r.top)/r.height*ch
      ];
    };

    const routePointsText=(route)=>{
      const pts=Array.isArray(route.points)?route.points:[];
      return pts.map(p=>`${Number(p[0]||0)},${Number(p[1]||0)}`).join(" ");
    };

    const arrowVisiblePoints=(route)=>{
      return Array.isArray(route.points)?clonePoints(route.points):[];
    };

    const updateRouteVisual=(edgeId)=>{
      const route=routes[edgeId];
      const visual=routeVisuals.get(edgeId);
      if(!route||!visual)return;

      const visiblePts=arrowVisiblePoints(route);
      const visibleText=visiblePts
        .map(p=>`${Number(p[0]||0)},${Number(p[1]||0)}`)
        .join(" ");

      visual.under.setAttribute("points",visibleText);
      visual.line.setAttribute("points",visibleText);

      // Keep the already-working full-line hit path unchanged.
      visual.hit.setAttribute("points",routePointsText(route));

      if(typeof visual.positionArrowHandle==="function"){
        visual.positionArrowHandle();
      }
      if(typeof visual.positionTerminalHandles==="function"){
        visual.positionTerminalHandles();
      }
      if(typeof visual.positionSourceEndpointHandle==="function"){
        visual.positionSourceEndpointHandle();
      }
      if(typeof visual.placeLockedArrow==="function"){
        visual.placeLockedArrow();
      }
    };

    // Arrow-length cleanup only. Remove redundant collinear/backtracking points
    // without changing the route endpoints or the orthogonal routing model.
    const sameRoutePoint=(a,b,eps=1e-9)=>
      !!a&&!!b&&Math.abs(Number(a[0])-Number(b[0]))<=eps&&Math.abs(Number(a[1])-Number(b[1]))<=eps;

    const canonicalRoutePoints=(raw)=>{
      const input=clonePoints(Array.isArray(raw)?raw:[]);
      const points=[];
      for(const p of input){
        if(!points.length||!sameRoutePoint(points[points.length-1],p))points.push([Number(p[0]),Number(p[1])]);
      }

      // Remove exact out-and-back spikes: A -> B -> A.
      let changed=true;
      while(changed&&points.length>=3){
        changed=false;
        for(let i=1;i<points.length-1;i++){
          if(sameRoutePoint(points[i-1],points[i+1])){
            points.splice(i,2);
            changed=true;
            break;
          }
        }
      }

      // Remove redundant collinear middle points. This also removes an old
      // over-extended terminal point when the new tip has been dragged back.
      changed=true;
      while(changed&&points.length>=3){
        changed=false;
        for(let i=1;i<points.length-1;i++){
          const a=points[i-1],b=points[i],c=points[i+1];
          const horizontal=Math.abs(a[1]-b[1])<=1e-9&&Math.abs(b[1]-c[1])<=1e-9;
          const vertical=Math.abs(a[0]-b[0])<=1e-9&&Math.abs(b[0]-c[0])<=1e-9;
          if(horizontal||vertical){
            points.splice(i,1);
            changed=true;
            break;
          }
        }
      }
      return points;
    };

    const refreshArrowAngleFromCurrentGeometry=(route)=>{
      // Arrow angle is intentionally not stored. draw/update functions calculate
      // atan2 from the route's current terminal segment on every visual refresh.
      delete route.__fixed_arrow_angle;
      delete route.__fixed_arrow_is_start;
    };

    // Fixed-direction terminal arrow editing. The arrow position is always the
    // actual terminal route point; only its angle is locked during arrow dragging.
    const fixedArrowGeometry=(route)=>{
      const geom=currentTerminalArrowGeometry(route);
      if(!geom)return null;

      const dx=Number(geom.tip[0])-Number(geom.previous[0]);
      const dy=Number(geom.tip[1])-Number(geom.previous[1]);
      const horizontal=Math.abs(dx)>=Math.abs(dy);
      const axisSign=horizontal
        ? (Math.abs(dx)>1e-9?Math.sign(dx):1)
        : (Math.abs(dy)>1e-9?Math.sign(dy):1);

      // Snapshot CURRENT terminal geometry at drag start.
      // It remains locked for this arrow drag, but a later line-geometry edit
      // can establish a different straight/L-bend terminal direction.
      return {
        direction:geom.direction,
        isStart:Boolean(geom.isStart),
        originalTip:[Number(geom.tip[0]),Number(geom.tip[1])],
        originalPrev:[Number(geom.previous[0]),Number(geom.previous[1])],
        horizontal,
        axisSign
      };
    };

    const appendPointNoDuplicate=(points,p)=>{
      if(!Array.isArray(p)||p.length<2)return;
      const q=[Number(p[0]),Number(p[1])];
      const last=points.length?points[points.length-1]:null;
      if(!last||Math.abs(Number(last[0])-q[0])>1e-9||Math.abs(Number(last[1])-q[1])>1e-9)points.push(q);
    };

    const segmentIsHorizontal=(a,b)=>{
      if(!a||!b)return true;
      return Math.abs(Number(b[0])-Number(a[0]))>=Math.abs(Number(b[1])-Number(a[1]));
    };

    const arrowDragProfile=(route,geom)=>{
      let oriented=canonicalRoutePoints(route.points);
      if(geom.isStart)oriented.reverse();
      if(oriented.length<2)return null;

      const last=oriented.length-1;

      // The editable length portion is ONLY the terminal section directly
      // before the arrow. Keep everything before its anchor untouched.
      const terminalStart=last-1;

      return {
        prefix:clonePoints(oriented.slice(0,terminalStart+1)),
        anchor:clonePoints([oriented[terminalStart]])[0],
        tip:clonePoints([oriented[last]])[0],

        // Decrease-only baseline: preserve the exact clean route that existed
        // when this arrow drag began. Increase behavior does not use this field.
        orientedBase:clonePoints(oriented)
      };
    };

    const trimPolylineFromArrowEnd=(rawPoints,trimDistance)=>{
      let points=cleanDraggedRoutePoints(rawPoints);
      if(points.length<2)return points;

      let remaining=Math.max(0,Number(trimDistance)||0);
      const epsilon=0.001;

      while(remaining>1e-9 && points.length>=2){
        const tip=points[points.length-1];
        const previous=points[points.length-2];

        const dx=Number(previous[0])-Number(tip[0]);
        const dy=Number(previous[1])-Number(tip[1]);
        const segmentLength=Math.hypot(dx,dy);

        if(segmentLength<=1e-9){
          points.pop();
          continue;
        }

        // Fully consumed segment: remove it completely.
        if(remaining>=segmentLength-1e-9){
          remaining-=segmentLength;
          points.pop();
          continue;
        }

        // Partially consumed segment: move only the current arrow endpoint
        // backward by exactly the remaining requested decrease distance.
        const ratio=remaining/segmentLength;
        points[points.length-1]=[
          Number(tip[0])+dx*ratio,
          Number(tip[1])+dy*ratio
        ];
        remaining=0;
      }

      points=cleanDraggedRoutePoints(points);

      // Keep a valid drawable two-point polyline only if the complete line was
      // reduced all the way to its opposite end. This microscopic stub is not an
      // additional bend/segment and prevents an invalid empty SVG route.
      if(points.length===1){
        const source=points[0];
        points.push([
          Number(source[0])+epsilon,
          Number(source[1])
        ]);
      }

      return cleanDraggedRoutePoints(points);
    };

    const moveRouteFromArrowHandle=(route,dragState,p)=>{
      const geom=dragState.arrowGeometry||fixedArrowGeometry(route);
      const profile=dragState.arrowProfile;
      if(!geom||!profile)return;

      const requestedTip=[
        Number(p[0])+Number((dragState.grabOffset&&dragState.grabOffset[0])||0),
        Number(p[1])+Number((dragState.grabOffset&&dragState.grabOffset[1])||0)
      ];
      const anchor=[Number(profile.anchor[0]),Number(profile.anchor[1])];
      const newTip=[Number(requestedTip[0]),Number(requestedTip[1])];

      // EXACT DRAG-DISTANCE DECREASE:
      // Use the terminal direction that was locked at pointer-down and measure
      // movement from the exact drag-start arrow tip. No accumulated route state
      // from previous pointermove events participates in this calculation.
      const terminalDx=Number(profile.tip[0])-Number(profile.anchor[0]);
      const terminalDy=Number(profile.tip[1])-Number(profile.anchor[1]);
      const terminalLength=Math.hypot(terminalDx,terminalDy);

      const unitX=terminalLength>1e-9 ? terminalDx/terminalLength : (geom.horizontal?Number(geom.axisSign||1):0);
      const unitY=terminalLength>1e-9 ? terminalDy/terminalLength : (geom.horizontal?0:Number(geom.axisSign||1));

      const dragDx=Number(newTip[0])-Number(profile.tip[0]);
      const dragDy=Number(newTip[1])-Number(profile.tip[1]);

      // Signed movement along the current line direction:
      // positive = increase, negative = decrease.
      const signedAdjustment=dragDx*unitX+dragDy*unitY;

      if(signedAdjustment<0){
        const decreaseDistance=-signedAdjustment;

        // Always rebuild from the immutable drag-start geometry. The amount
        // removed from the full polyline is exactly the amount the user dragged
        // backward, so extending and then shortening cannot leave old geometry.
        let reduced=trimPolylineFromArrowEnd(
          Array.isArray(profile.orientedBase)
            ? profile.orientedBase
            : [...clonePoints(profile.prefix),clonePoints([profile.tip])[0]],
          decreaseDistance
        );

        if(geom.isStart)reduced.reverse();
        route.points=canonicalRoutePoints(reduced);
        delete route.arrow_control;
        return;
      }

      // EXISTING INCREASE BEHAVIOR BELOW IS UNCHANGED.
      if(geom.horizontal){
        newTip[0]=geom.axisSign>=0
          ? Math.max(newTip[0],anchor[0])
          : Math.min(newTip[0],anchor[0]);
      }else{
        newTip[1]=geom.axisSign>=0
          ? Math.max(newTip[1],anchor[1])
          : Math.min(newTip[1],anchor[1]);
      }

      // IMPORTANT: start from the immutable drag-start prefix every time.
      // The old terminal extension is never carried forward.
      const moved=clonePoints(profile.prefix);

      if(geom.horizontal){
        if(Math.abs(newTip[1]-anchor[1])>1e-7){
          // Free vertical movement creates/updates one L bend.
          appendPointNoDuplicate(moved,[anchor[0],newTip[1]]);
        }
        appendPointNoDuplicate(moved,newTip);
      }else{
        if(Math.abs(newTip[0]-anchor[0])>1e-7){
          // Free horizontal movement creates/updates one L bend.
          appendPointNoDuplicate(moved,[newTip[0],anchor[1]]);
        }
        appendPointNoDuplicate(moved,newTip);
      }

      if(geom.isStart)moved.reverse();
      route.points=canonicalRoutePoints(moved);
      delete route.arrow_control;
    };

    // Standard flowchart connector editing only.
    // A dragged segment remains horizontal or vertical; real component-port
    // endpoints never rotate or detach. Terminal-segment drags create a small
    // orthogonal dogleg, matching normal flowchart editors.
    const orthogonalSegmentDragPoints=(base,segmentIndex,startPoint,currentPoint)=>{
      const points=canonicalRoutePoints(base);
      if(points.length<2)return clonePoints(points);

      const i=Math.max(0,Math.min(points.length-2,Number(segmentIndex)||0));
      const a=points[i],b=points[i+1];
      if(!a||!b)return clonePoints(points);

      const horizontal=segmentIsHorizontal(a,b);
      const pointerDx=Number(currentPoint[0])-Number(startPoint[0]);
      const pointerDy=Number(currentPoint[1])-Number(startPoint[1]);
      const lane=horizontal
        ? ((Number(a[1])+Number(b[1]))/2)+pointerDy
        : ((Number(a[0])+Number(b[0]))/2)+pointerDx;

      const terminalStub=(from,to)=>{
        const length=Math.hypot(
          Number(to[0])-Number(from[0]),
          Number(to[1])-Number(from[1])
        );
        // Keep a visible but compact terminal stub. Never consume more than
        // one quarter of a short original segment, so source/target stubs do
        // not cross each other on small connectors.
        return Math.max(0.08,Math.min(0.30,length*0.25));
      };

      // Straight line: keep both real endpoints fixed and create one clean
      // Manhattan corridor through the dragged lane.
      if(points.length===2){
        const source=clonePoints([points[0]])[0];
        const target=clonePoints([points[1]])[0];
        const len=Math.hypot(target[0]-source[0],target[1]-source[1]);
        const stub=Math.max(0.06,Math.min(0.28,len*0.22));

        if(horizontal){
          const sign=Math.abs(target[0]-source[0])>1e-9
            ? Math.sign(target[0]-source[0])
            : 1;
          const sx=source[0]+sign*stub;
          const tx=target[0]-sign*stub;
          return cleanDraggedRoutePoints([
            source,
            [sx,source[1]],
            [sx,lane],
            [tx,lane],
            [tx,target[1]],
            target
          ]);
        }

        const sign=Math.abs(target[1]-source[1])>1e-9
          ? Math.sign(target[1]-source[1])
          : 1;
        const sy=source[1]+sign*stub;
        const ty=target[1]-sign*stub;
        return cleanDraggedRoutePoints([
          source,
          [source[0],sy],
          [lane,sy],
          [lane,ty],
          [target[0],ty],
          target
        ]);
      }

      // Interior segment: move only perpendicular to itself. Because the
      // neighboring segments are orthogonal, moving both segment endpoints on
      // the same axis preserves every right-angle bend without rotation.
      if(i>0 && i<points.length-2){
        const result=clonePoints(points);
        if(horizontal){
          result[i][1]=lane;
          result[i+1][1]=lane;
        }else{
          result[i][0]=lane;
          result[i+1][0]=lane;
        }
        return cleanDraggedRoutePoints(result);
      }

      // Source-terminal segment: keep the actual source port fixed. A compact
      // port stub + lane replaces free rotation.
      if(i===0){
        const source=clonePoints([points[0]])[0];
        const next=clonePoints([points[1]])[0];
        const rest=clonePoints(points.slice(2));
        const stub=terminalStub(source,next);

        if(horizontal){
          const sign=Math.abs(next[0]-source[0])>1e-9
            ? Math.sign(next[0]-source[0])
            : 1;
          const stubX=source[0]+sign*stub;
          return cleanDraggedRoutePoints([
            source,
            [stubX,source[1]],
            [stubX,lane],
            [next[0],lane],
            ...rest
          ]);
        }

        const sign=Math.abs(next[1]-source[1])>1e-9
          ? Math.sign(next[1]-source[1])
          : 1;
        const stubY=source[1]+sign*stub;
        return cleanDraggedRoutePoints([
          source,
          [source[0],stubY],
          [lane,stubY],
          [lane,next[1]],
          ...rest
        ]);
      }

      // Target-terminal segment: mirror the source behavior so the real target
      // port remains fixed while the terminal route is adjusted orthogonally.
      const before=clonePoints(points.slice(0,-2));
      const previous=clonePoints([points[points.length-2]])[0];
      const target=clonePoints([points[points.length-1]])[0];
      const stub=terminalStub(previous,target);

      if(horizontal){
        const sign=Math.abs(target[0]-previous[0])>1e-9
          ? Math.sign(target[0]-previous[0])
          : 1;
        const stubX=target[0]-sign*stub;
        return cleanDraggedRoutePoints([
          ...before,
          [previous[0],lane],
          [stubX,lane],
          [stubX,target[1]],
          target
        ]);
      }

      const sign=Math.abs(target[1]-previous[1])>1e-9
        ? Math.sign(target[1]-previous[1])
        : 1;
      const stubY=target[1]-sign*stub;
      return cleanDraggedRoutePoints([
        ...before,
        [lane,previous[1]],
        [lane,stubY],
        [target[0],stubY],
        target
      ]);
    };

    // Port-lock helpers for standard flowchart behavior. A route remembers the
    // exact side + relative position of the component port it was already using.
    // Moving a component resolves that same reference against the new component
    // box, so the endpoint cannot drift, clip, rotate away, or detach.
    const inferPortReference=(box,point)=>{
      if(!Array.isArray(box)||box.length!==4||!Array.isArray(point)||point.length<2)return null;
      const [x,y,w,h]=box.map(Number);
      const px=Number(point[0]),py=Number(point[1]);
      const safeW=Math.max(Math.abs(w),1e-9),safeH=Math.max(Math.abs(h),1e-9);
      const candidates=[
        {side:"left",distance:Math.abs(px-x),ratio:clamp((py-y)/safeH,0,1)},
        {side:"right",distance:Math.abs(px-(x+w)),ratio:clamp((py-y)/safeH,0,1)},
        {side:"top",distance:Math.abs(py-y),ratio:clamp((px-x)/safeW,0,1)},
        {side:"bottom",distance:Math.abs(py-(y+h)),ratio:clamp((px-x)/safeW,0,1)}
      ];
      candidates.sort((a,b)=>a.distance-b.distance);
      return {side:candidates[0].side,ratio:Number(candidates[0].ratio)};
    };

    const resolvePortReference=(box,reference)=>{
      if(!Array.isArray(box)||box.length!==4||!reference)return null;
      const [x,y,w,h]=box.map(Number);
      const ratio=clamp(Number(reference.ratio)||0,0,1);
      if(reference.side==="left")return[x,y+h*ratio];
      if(reference.side==="right")return[x+w,y+h*ratio];
      if(reference.side==="top")return[x+w*ratio,y];
      if(reference.side==="bottom")return[x+w*ratio,y+h];
      return null;
    };

    const moveConnectedRouteEndpointToPort=(base,isSource,portPoint)=>{
      const points=canonicalRoutePoints(base);
      if(points.length<2||!Array.isArray(portPoint)||portPoint.length<2)return clonePoints(points);
      const lockedPort=[Number(portPoint[0]),Number(portPoint[1])];

      // Two-point routes are converted to one predictable Manhattan corridor,
      // keeping both real component ports as immutable endpoints.
      if(points.length===2){
        const source=clonePoints([points[0]])[0];
        const target=clonePoints([points[1]])[0];
        const horizontal=segmentIsHorizontal(source,target);
        if(isSource)source.splice(0,2,...lockedPort);
        else target.splice(0,2,...lockedPort);

        if(horizontal){
          const midX=(source[0]+target[0])/2;
          return cleanDraggedRoutePoints([
            source,
            [midX,source[1]],
            [midX,target[1]],
            target
          ]);
        }

        const midY=(source[1]+target[1])/2;
        return cleanDraggedRoutePoints([
          source,
          [source[0],midY],
          [target[0],midY],
          target
        ]);
      }

      // Existing elbow geometry is preserved. Only the locked terminal point and
      // the coordinate required to keep its adjacent segment orthogonal change.
      const result=clonePoints(points);
      if(isSource){
        const oldEnd=points[0],oldAdjacent=points[1];
        const horizontal=segmentIsHorizontal(oldEnd,oldAdjacent);
        result[0]=lockedPort;
        if(horizontal)result[1][1]=lockedPort[1];
        else result[1][0]=lockedPort[0];
      }else{
        const last=points.length-1;
        const oldAdjacent=points[last-1],oldEnd=points[last];
        const horizontal=segmentIsHorizontal(oldAdjacent,oldEnd);
        result[last]=lockedPort;
        if(horizontal)result[last-1][1]=lockedPort[1];
        else result[last-1][0]=lockedPort[0];
      }
      return cleanDraggedRoutePoints(result);
    };

    const routePointDistance=(a,b)=>Math.hypot(
      Number(a[0])-Number(b[0]),
      Number(a[1])-Number(b[1])
    );

    const pointToSegmentDistance=(p,a,b)=>{
      const ax=Number(a[0]),ay=Number(a[1]);
      const bx=Number(b[0]),by=Number(b[1]);
      const px=Number(p[0]),py=Number(p[1]);
      const vx=bx-ax,vy=by-ay;
      const len2=vx*vx+vy*vy;
      if(len2<=1e-12)return Math.hypot(px-ax,py-ay);
      const t=Math.max(0,Math.min(1,((px-ax)*vx+(py-ay)*vy)/len2));
      const qx=ax+t*vx,qy=ay+t*vy;
      return Math.hypot(px-qx,py-qy);
    };

    const segmentOrientation=(a,b,c)=>{
      const value=(Number(b[0])-Number(a[0]))*(Number(c[1])-Number(a[1]))
        -(Number(b[1])-Number(a[1]))*(Number(c[0])-Number(a[0]));
      if(Math.abs(value)<1e-9)return 0;
      return value>0?1:-1;
    };

    const segmentsProperlyCross=(a,b,c,d)=>{
      const o1=segmentOrientation(a,b,c);
      const o2=segmentOrientation(a,b,d);
      const o3=segmentOrientation(c,d,a);
      const o4=segmentOrientation(c,d,b);
      return o1!==0&&o2!==0&&o3!==0&&o4!==0&&o1!==o2&&o3!==o4;
    };

    const shareOnlyEndpoint=(a,b,c,d)=>{
      const eps=0.035;
      return (
        routePointDistance(a,c)<=eps ||
        routePointDistance(a,d)<=eps ||
        routePointDistance(b,c)<=eps ||
        routePointDistance(b,d)<=eps
      );
    };

    const segmentTooClose=(a,b,c,d,clearance)=>{
      if(segmentsProperlyCross(a,b,c,d))return true;

      // Exact/common component endpoint contact is allowed, but the lines may not
      // run together after leaving that endpoint.
      const sharedEndpoint=shareOnlyEndpoint(a,b,c,d);
      const minDistance=Math.min(
        pointToSegmentDistance(a,c,d),
        pointToSegmentDistance(b,c,d),
        pointToSegmentDistance(c,a,b),
        pointToSegmentDistance(d,a,b)
      );

      if(sharedEndpoint){
        return minDistance<Math.min(clearance,0.045)
          && !(
            routePointDistance(a,c)<=0.035 ||
            routePointDistance(a,d)<=0.035 ||
            routePointDistance(b,c)<=0.035 ||
            routePointDistance(b,d)<=0.035
          );
      }
      return minDistance<clearance;
    };

    const routeConflictsWithOtherRoutes=(edgeId,candidate)=>{
      // Slightly smaller safety clearance gives the user more room to position a
      // connection close to another route while still preventing real overlap/crossing.
      const clearance=0.090;
      if(!Array.isArray(candidate)||candidate.length<2)return false;

      for(const other of Object.values(routes)){
        if(!other||other.hidden||String(other.edge_id||"")===String(edgeId||""))continue;
        const otherPoints=canonicalRoutePoints(other.points);
        if(otherPoints.length<2)continue;

        for(let i=0;i<candidate.length-1;i++){
          const a=candidate[i],b=candidate[i+1];
          if(routePointDistance(a,b)<1e-8)continue;
          for(let j=0;j<otherPoints.length-1;j++){
            const c=otherPoints[j],d=otherPoints[j+1];
            if(routePointDistance(c,d)<1e-8)continue;

            // Permit one exact shared terminal point between two valid connections,
            // but reject every crossing/parallel overlap away from that terminal.
            const shared=
              routePointDistance(a,c)<=0.035 ||
              routePointDistance(a,d)<=0.035 ||
              routePointDistance(b,c)<=0.035 ||
              routePointDistance(b,d)<=0.035;

            if(segmentsProperlyCross(a,b,c,d))return true;

            const minDistance=Math.min(
              pointToSegmentDistance(a,c,d),
              pointToSegmentDistance(b,c,d),
              pointToSegmentDistance(c,a,b),
              pointToSegmentDistance(d,a,b)
            );

            if(!shared && minDistance<clearance)return true;

            // If they share an endpoint, sample just beyond the shared end so two
            // lines cannot continue on top of each other from the same component.
            if(shared){
              const sample=(p,q,t)=>[
                Number(p[0])+(Number(q[0])-Number(p[0]))*t,
                Number(p[1])+(Number(q[1])-Number(p[1]))*t
              ];
              const aNear=sample(a,b,0.12),bNear=sample(b,a,0.12);
              const cNear=sample(c,d,0.12),dNear=sample(d,c,0.12);
              const nearDistance=Math.min(
                pointToSegmentDistance(aNear,cNear,dNear),
                pointToSegmentDistance(bNear,cNear,dNear),
                pointToSegmentDistance(cNear,aNear,bNear),
                pointToSegmentDistance(dNear,aNear,bNear)
              );
              if(nearDistance<clearance*0.72)return true;
            }
          }
        }
      }
      return false;
    };

    const smoothDragPoint=(dragState,p)=>{
      const incoming=[Number(p[0]),Number(p[1])];
      if(!Array.isArray(dragState.smoothedPoint)){
        dragState.smoothedPoint=incoming;
        return incoming;
      }

      // Light low-pass filtering: keeps the line responsive while removing the
      // tiny pointer jitter that makes thin connection lines difficult to place.
      // A little more pointer weight keeps the line responsive for fine manual
      // adjustment without removing the existing jitter filtering.
      const alpha=0.68;
      dragState.smoothedPoint=[
        dragState.smoothedPoint[0]+(incoming[0]-dragState.smoothedPoint[0])*alpha,
        dragState.smoothedPoint[1]+(incoming[1]-dragState.smoothedPoint[1])*alpha
      ];
      return dragState.smoothedPoint;
    };

    const cleanDraggedRoutePoints=(raw)=>{
      let pts=canonicalRoutePoints(raw);
      if(pts.length<3)return pts;

      // Remove any collinear middle point, including diagonal out-and-back
      // remnants created by previous 360° drags.
      let changed=true;
      while(changed&&pts.length>=3){
        changed=false;
        for(let i=1;i<pts.length-1;i++){
          const a=pts[i-1],b=pts[i],c=pts[i+1];
          const abx=Number(b[0])-Number(a[0]);
          const aby=Number(b[1])-Number(a[1]);
          const bcx=Number(c[0])-Number(b[0]);
          const bcy=Number(c[1])-Number(b[1]);
          const cross=abx*bcy-aby*bcx;

          const scale=Math.max(
            1,
            Math.hypot(abx,aby),
            Math.hypot(bcx,bcy)
          );

          if(Math.abs(cross)<=1e-8*scale){
            pts.splice(i,1);
            changed=true;
            break;
          }
        }
      }

      // Remove exact A->B->A spikes one more time after diagonal cleanup.
      changed=true;
      while(changed&&pts.length>=3){
        changed=false;
        for(let i=1;i<pts.length-1;i++){
          if(sameRoutePoint(pts[i-1],pts[i+1],1e-8)){
            pts.splice(i,2);
            changed=true;
            break;
          }
        }
      }

      return pts;
    };

    const routeHasSelfOverlapOrCrossing=(points)=>{
      const pts=cleanDraggedRoutePoints(points);
      if(pts.length<4)return false;

      const clearance=0.055;

      for(let i=0;i<pts.length-1;i++){
        const a=pts[i],b=pts[i+1];
        if(routePointDistance(a,b)<1e-8)continue;

        for(let j=i+2;j<pts.length-1;j++){
          // Adjacent segments naturally meet at one endpoint.
          if(j===i+1)continue;
          // First and last segments may share the same route endpoint only in a
          // closed loop; such a loop is not valid for these connections.
          const c=pts[j],d=pts[j+1];
          if(routePointDistance(c,d)<1e-8)continue;

          if(segmentsProperlyCross(a,b,c,d))return true;

          const shared=
            routePointDistance(a,c)<=1e-8 ||
            routePointDistance(a,d)<=1e-8 ||
            routePointDistance(b,c)<=1e-8 ||
            routePointDistance(b,d)<=1e-8;

          const minDistance=Math.min(
            pointToSegmentDistance(a,c,d),
            pointToSegmentDistance(b,c,d),
            pointToSegmentDistance(c,a,b),
            pointToSegmentDistance(d,a,b)
          );

          if(!shared && minDistance<clearance)return true;
        }
      }
      return false;
    };

    const nearestNonOverlappingDragRoute=(route,dragState,p)=>{
      const smoothPoint=smoothDragPoint(dragState,p);
      const edgeId=String(route.edge_id||dragState.edgeId||"");

      const buildCleanCandidate=(pointerPoint)=>
        cleanDraggedRoutePoints(
          orthogonalSegmentDragPoints(
            dragState.base,
            dragState.segment,
            dragState.start,
            pointerPoint
          )
        );

      const isSafe=(candidate)=>
        !routeHasSelfOverlapOrCrossing(candidate)
        && !routeConflictsWithOtherRoutes(edgeId,candidate);

      const candidate=buildCleanCandidate(smoothPoint);
      if(isSafe(candidate))return candidate;

      // Search only close to the requested pointer position, preferring the
      // smallest displacement that keeps this connection clear and separated.
      // Use a finer nearby search so the dragged line can settle closer to the
      // requested pointer position instead of jumping to a coarse safe location.
      const step=0.075;
      const rings=12;
      const basePoints=canonicalRoutePoints(dragState.base);
      const segIndex=Math.max(0,Math.min(basePoints.length-2,Number(dragState.segment)||0));
      const segA=basePoints[segIndex],segB=basePoints[segIndex+1];
      const horizontal=segmentIsHorizontal(segA,segB);

      // Standard flowchart behavior: if collision avoidance needs a nearby lane,
      // search only perpendicular to the selected segment. Never rotate it.
      for(let ring=1;ring<=rings;ring++){
        const radius=step*ring;
        for(const sign of [1,-1]){
          const trialPoint=horizontal
            ? [smoothPoint[0],smoothPoint[1]+sign*radius]
            : [smoothPoint[0]+sign*radius,smoothPoint[1]];
          const trial=buildCleanCandidate(trialPoint);
          if(isSafe(trial))return trial;
        }
      }

      // Never leave a duplicate/crossing segment behind. Reuse the last clean
      // valid route, or the clean drag-start geometry if nothing moved safely.
      const fallback=Array.isArray(dragState.lastValidPoints)
        ? dragState.lastValidPoints
        : dragState.base;
      return cleanDraggedRoutePoints(fallback);
    };

    const moveRouteSegment=(route,dragState,p)=>{
      const next=cleanDraggedRoutePoints(
        nearestNonOverlappingDragRoute(route,dragState,p)
      );
      route.points=next;
      dragState.lastValidPoints=clonePoints(next);
    };

    // Sump / Bore Well visibility guard only.
    // Keep these two base component images fully inside the visible worksheet
    // when their generated/restored box lands partially outside the canvas.
    // Existing route behavior is preserved by moving only the attached endpoint
    // geometry through the already-working endpoint adjustment helper.
    const keepBaseWaterSourceImagesVisible=()=>{
      const margin=Math.max(0.035,Math.min(0.10,Math.min(cw,ch)*0.006));

      const isRequestedBaseImage=(component)=>{
        const raw=`${String(component?.component||"")} ${String(component?.title||"")}`
          .toLowerCase()
          .replace(/[^a-z0-9]+/g,"");
        return raw.includes("sump") || raw.includes("borewell");
      };

      for(const component of Object.values(components)){
        if(!component||component.hidden||!isRequestedBaseImage(component))continue;

        const id=String(component.instance_id||"");
        const [x,y,w,h]=cloneBox(component.box);
        const maxX=Math.max(margin,cw-w-margin);
        const maxY=Math.max(margin,ch-h-margin);
        const nx=clamp(x,margin,maxX);
        const ny=clamp(y,margin,maxY);
        const dx=nx-x;
        const dy=ny-y;

        if(Math.abs(dx)<=1e-9&&Math.abs(dy)<=1e-9)continue;

        component.box=[nx,ny,w,h];

        // Preserve all existing line/arrow behavior: only move the endpoint that
        // belongs to this shifted component by the same visibility correction.
        for(const route of connectedRoutes(id)){
          if(route.stored_geometry||route.sketch_lock||route.manual_drag)continue;
          if(String(route.source||"")===id){
            route.points=moveConnectedRouteEndpoint(route.points,true,dx,dy);
          }
          if(String(route.target||"")===id){
            route.points=moveConnectedRouteEndpoint(route.points,false,dx,dy);
          }
          route.points=cleanDraggedRoutePoints(route.points);
          refreshArrowAngleFromCurrentGeometry(route);
        }
      }
    };

    // The visible image layer now handles Worksheet-edge clipping directly.
    // Do not move logical component boxes here; that preserves the existing
    // label positions, connection endpoints, routing and saved component layout.

    const drawDragOnlyRoutes=()=>{
      routeSvg.innerHTML="";
      routeVisuals.clear();
      const deleteRouteButton=document.createElement("button");
      deleteRouteButton.type="button";
      deleteRouteButton.textContent="Delete connection";
      deleteRouteButton.title="Delete selected connection";
      deleteRouteButton.style.cssText="display:none;position:absolute;right:12px;top:12px;z-index:100;padding:7px 11px;border:1px solid #b91c1c;border-radius:4px;background:#dc2626;color:#fff;font:600 13px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.2);";
      deleteRouteButton.addEventListener("pointerdown",event=>{
        event.preventDefault();
        event.stopPropagation();
      });
      deleteRouteButton.addEventListener("click",event=>{
        event.preventDefault();
        event.stopPropagation();
        const edgeId=dragOnlyRouteAction?.selected;
        if(!edgeId)return;
        const route=routes[edgeId]||{};
        const source=String(route.source||"");
        const target=String(route.target||"");
        dragOnlyRouteAction.remove(edgeId);
        emitConnectionDelete(edgeId,source,target);
      });
      stage.appendChild(deleteRouteButton);
      dragOnlyRouteAction={
        selected:null,
        select(edgeId){
          this.selected=String(edgeId||"");
          deleteRouteButton.style.display=this.selected?"block":"none";
          if(this.selected)root.focus({preventScroll:true});
          for(const [id,visual] of routeVisuals){
            const active=id===this.selected;
            visual.line.setAttribute("stroke",active?"#0a66e3":(routePairIsWater(routes[id])?"#123DBD":(routes[id]?.dotted?"#000000":"#123DBD")));
            if(!active&&routePairIsWater(routes[id])){
              visual.line.setAttribute("stroke-dasharray","none");
              visual.line.style.strokeDasharray="none";
            }
            visual.line.setAttribute("stroke-width",active?"0.026":"0.015");
            visual.under.setAttribute("stroke",active?"#b9d7ff":"#ffffff");
          }
        },
        remove(edgeId){
          const id=String(edgeId||"");
          const removed=permanentlyRemoveRoute(id);
          if(!removed)return;
          if(this.selected===id){
            this.selected=null;
            deleteRouteButton.style.display="none";
          }
          const visual=routeVisuals.get(id);
          if(visual){
            visual.under.remove();
            visual.line.remove();
            visual.hit.remove();
            visual.arrowVisual?.remove();
            visual.arrowHandle?.remove();
            visual.sourceTerminalHandle?.remove();
            visual.targetTerminalHandle?.remove();
            visual.sourceEndpointHandle?.remove();
          }
          routeVisuals.delete(id);
        }
      };

      const openRenderedRouteMenu=(clientX,clientY,edgeId)=>{
        const id=String(edgeId||"");
        const route=routes[id];
        if(!route||route.hidden)return;
        if(dragOnlyRouteAction)dragOnlyRouteAction.select(id);
        openContext(clientX,clientY,"edge",id);
        if(contextMenu)contextMenu.style.zIndex="400";
      };

      // Direction arrows keep the existing orange appearance.
      const defs=routeEl("defs",{});
      routeSvg.appendChild(defs);

      // Arrow pose is derived live from the current terminal segment.
      // atan2 is recalculated whenever route geometry changes.
      const originalArrowAngle=(route)=>{
        const pose=originalArrowPose(route);
        return pose?pose.angle:0;
      };

      // Saved-project freeze: paint sealed payload only — do not rewrite routes
      // or invent fluid_bore_sump / header geometry over freeze-at-save lines.
      if(!argsState.freeze_saved_geometry){
        forceDottedOhtTransmitterOntoSensor();
        hideEmbeddedOhtSensorRoutes();
        purgeUnsolicitedDottedRoutes();
        seatInlineDevicesOnOhtDrops();
        forceUnifiedFluidHeader();
        forceBoreSumpReturn();
        bindLoadedConnectionGeometry();
        seatInlineDevicesOnOhtDrops();
        forceUnifiedFluidHeader();
        forceBoreSumpReturn();
        purgeUnsolicitedDottedRoutes();
      }
      for(const route of Object.values(routes)){
        if(route.hidden||routeLinksEmbeddedOhtSensor(route))continue;
        const pts=Array.isArray(route.points)?route.points:[];
        if(pts.length<2)continue;
        const edgeId=String(route.edge_id||"");
        const visiblePts=arrowVisiblePoints(route);
        const points=visiblePts
          .map(p=>`${Number(p[0]||0)},${Number(p[1]||0)}`)
          .join(" ");

        const sourceName=String(components[String(route.source||"")]?.component||"");
        const targetName=String(components[String(route.target||"")]?.component||"");
        const waterLine=routePairIsWater(route);
        if(waterLine){
          route.dotted=false;
          route.color="#123DBD";
          route.fluid_header=true;
        }
        const drawsOverTank=!!(
          !waterLine && (
            route.sensor_transmitter ||
            (
              route.dotted &&
              (
                (sourceName==="Linear Level Sensor (LLS)"&&targetName==="Transmitter") ||
                (targetName==="Linear Level Sensor (LLS)"&&sourceName==="Transmitter")
              )
            )
          )
        );
        const routeHost=drawsOverTank?sensorRouteSvg:routeSvg;
        const under=routeEl("polyline",{
          points,fill:"none",stroke:"#ffffff","stroke-width":"0.030",
          "stroke-linejoin":"round","stroke-linecap":"round",
          "pointer-events":"none"
        });
        routeHost.appendChild(under);

        const line=routeEl("polyline",{
          points,fill:"none",
          stroke:waterLine?"#123DBD":(route.dotted?"#000000":"#123DBD"),
          "stroke-width":"0.018","stroke-linejoin":"round","stroke-linecap":"round",
          "stroke-opacity":"1",
          "pointer-events":"none"
        });
        applySolidBlueWaterStroke(line,route);
        const direction=String(route.direction||"source_to_target");
        routeHost.appendChild(line);

        // Draw the existing orange arrow as its own SVG shape instead of an SVG
        // marker. Its tip stays on the terminal route point and its angle is
        // recalculated from the current terminal segment on every update.
        originalArrowAngle(route);
        const arrowVisual=routeEl("path",{
          d:"M 0 0 L -0.110 -0.042 L -0.110 0.042 z",
          fill:"#ff7a00",
          stroke:"#ffffff",
          "stroke-width":"0.004",
          "pointer-events":"none"
        });
        routeHost.appendChild(arrowVisual);

        const placeLockedArrow=()=>{
          const pose=originalArrowPose(route);
          if(!pose)return;
          arrowVisual.setAttribute(
            "transform",
            `translate(${Number(pose.tip[0]||0)} ${Number(pose.tip[1]||0)}) rotate(${Number(pose.angle)})`
          );
        };
        placeLockedArrow();

        // Invisible grab area only. Visible style/thickness stays untouched.
        // A wider hit stroke makes thin/dotted/bundled lines reliably selectable.
        const hit=routeEl("polyline",{
          points:routePointsText(route),
          fill:"none",
          stroke:"rgba(0,0,0,0.002)",
          "stroke-width":"14",
          "vector-effect":"non-scaling-stroke",
          "stroke-linejoin":"round",
          "stroke-linecap":"round",
          style:"pointer-events:stroke;cursor:grab;touch-action:none;"
        });
        hit.dataset.edgeId=edgeId;
        routeHost.appendChild(hit);
        if(drawsOverTank)hit.style.pointerEvents="stroke";

        // Keep the existing visible orange arrow exactly unchanged.
        // Use a transparent HTML drag target above the component hit layer.
        // The arrow sits at a component endpoint, so an SVG-only target can be
        // blocked by the component's own interaction box.
        const arrowHandle=document.createElement("div");
        arrowHandle.dataset.edgeId=edgeId;
        arrowHandle.dataset.routeArrowHandle="1";
        arrowHandle.title="Drag to adjust the connected route";
        arrowHandle.style.cssText=[
          "position:absolute",
          "z-index:80",
          "width:42px",
          "height:42px",
          "margin-left:-21px",
          "margin-top:-21px",
          "cursor:grab",
          "touch-action:none",
          "pointer-events:auto",
          "background:transparent",
          "border:none",
          "user-select:none"
        ].join(";");

        const positionArrowHandle=()=>{
          const routePts=Array.isArray(route.points)?route.points:[];
          if(!routePts.length)return;

          const pose=originalArrowPose(route);
          if(!pose)return;
          const arrowPoint=pose.tip;

          arrowHandle.style.left=`${(Number(arrowPoint[0]||0)/Math.max(1,cw))*100}%`;
          arrowHandle.style.top=`${(Number(arrowPoint[1]||0)/Math.max(1,ch))*100}%`;
        };
        positionArrowHandle();
        stage.appendChild(arrowHandle);

        // Endpoint-side manual line editing only.
        // These transparent handles sit above the component interaction layer so
        // the short source/target line sections beside a component remain directly
        // draggable. They reuse the existing segment-drag routine; no routing,
        // connection, arrow or component behavior is changed.
        const terminalSegmentInfo=(isSource)=>{
          const pts=Array.isArray(route.points)?route.points:[];
          if(pts.length<2)return null;

          if(isSource){
            for(let i=0;i<pts.length-1;i++){
              const a=pts[i],b=pts[i+1];
              if(Math.hypot(Number(b[0])-Number(a[0]),Number(b[1])-Number(a[1]))>1e-9){
                return {index:i,a,b};
              }
            }
            return null;
          }

          for(let i=pts.length-2;i>=0;i--){
            const a=pts[i],b=pts[i+1];
            if(Math.hypot(Number(b[0])-Number(a[0]),Number(b[1])-Number(a[1]))>1e-9){
              return {index:i,a,b};
            }
          }
          return null;
        };

        const createTerminalSegmentHandle=(isSource)=>{
          const handle=document.createElement("div");
          handle.dataset.edgeId=edgeId;
          handle.dataset.routeTerminalHandle=isSource?"source":"target";
          handle.title="Drag to adjust this connection segment";
          handle.style.cssText=[
            "position:absolute",
            "z-index:79",
            "cursor:grab",
            "touch-action:none",
            "pointer-events:auto",
            "background:transparent",
            "border:none",
            "padding:0",
            "margin:0",
            "user-select:none",
            "box-sizing:border-box"
          ].join(";");
          stage.appendChild(handle);
          return handle;
        };

        const sourceTerminalHandle=createTerminalSegmentHandle(true);
        const targetTerminalHandle=createTerminalSegmentHandle(false);

        // Start-point editing only. This transparent handle is centered exactly
        // on route.points[0] and sits above the component hit layer. Dragging it
        // slides the existing source endpoint along its CURRENT component side;
        // the endpoint never detaches and all existing routing/arrow behavior is
        // otherwise left untouched.
        const sourceEndpointHandle=document.createElement("div");
        sourceEndpointHandle.dataset.edgeId=edgeId;
        sourceEndpointHandle.dataset.routeSourceEndpointHandle="1";
        sourceEndpointHandle.title="Drag to adjust the connection start point / first bend";
        sourceEndpointHandle.style.cssText=[
          "position:absolute",
          "z-index:82",
          "width:42px",
          "height:42px",
          "margin-left:-21px",
          "margin-top:-21px",
          "cursor:grab",
          "touch-action:none",
          "pointer-events:auto",
          "background:transparent",
          "border:none",
          "padding:0",
          "user-select:none",
          "box-sizing:border-box"
        ].join(";");
        stage.appendChild(sourceEndpointHandle);

        const positionSourceEndpointHandle=()=>{
          const pts=Array.isArray(route.points)?route.points:[];
          if(!pts.length){
            sourceEndpointHandle.style.display="none";
            return;
          }
          sourceEndpointHandle.style.display="block";
          const startPoint=pts[0];
          sourceEndpointHandle.style.left=`${(Number(startPoint[0]||0)/Math.max(1,cw))*100}%`;
          sourceEndpointHandle.style.top=`${(Number(startPoint[1]||0)/Math.max(1,ch))*100}%`;
        };
        positionSourceEndpointHandle();

        const pointOnLockedComponentSide=(box,reference,p)=>{
          if(!Array.isArray(box)||box.length!==4||!reference||!Array.isArray(p))return null;
          const [x,y,w,h]=box.map(Number);
          const safeW=Math.max(Math.abs(w),1e-9);
          const safeH=Math.max(Math.abs(h),1e-9);
          let ratio=Number(reference.ratio)||0;
          if(reference.side==="left"||reference.side==="right"){
            ratio=clamp((Number(p[1])-y)/safeH,0,1);
          }else if(reference.side==="top"||reference.side==="bottom"){
            ratio=clamp((Number(p[0])-x)/safeW,0,1);
          }
          return draftResolvePortReference(box,{side:reference.side,ratio});
        };

        // Any-side start-point selection only. Keep the existing same-side start
        // adjustment untouched; this helper only determines which component side
        // the pointer is currently closest to while the existing start handle is
        // being dragged. Ties prefer the currently active side to avoid flicker.
        const sourcePortReferenceAtPointer=(box,currentReference,p)=>{
          if(!Array.isArray(box)||box.length!==4||!Array.isArray(p))return null;
          const [x,y,w,h]=box.map(Number);
          const px=Number(p[0]),py=Number(p[1]);
          const x2=x+w,y2=y+h;
          const safeW=Math.max(Math.abs(w),1e-9);
          const safeH=Math.max(Math.abs(h),1e-9);
          const clampX=clamp(px,Math.min(x,x2),Math.max(x,x2));
          const clampY=clamp(py,Math.min(y,y2),Math.max(y,y2));
          const candidates=[
            {side:"left",point:[x,clampY]},
            {side:"right",point:[x2,clampY]},
            {side:"top",point:[clampX,y]},
            {side:"bottom",point:[clampX,y2]}
          ].map(item=>({
            ...item,
            distance:Math.hypot(px-Number(item.point[0]),py-Number(item.point[1]))
          }));

          candidates.sort((a,b)=>{
            const diff=a.distance-b.distance;
            if(Math.abs(diff)>1e-9)return diff;
            if(currentReference&&a.side===currentReference.side)return -1;
            if(currentReference&&b.side===currentReference.side)return 1;
            return 0;
          });

          const chosen=candidates[0];
          let ratio=0;
          if(chosen.side==="left"||chosen.side==="right"){
            ratio=clamp((Number(chosen.point[1])-y)/safeH,0,1);
          }else{
            ratio=clamp((Number(chosen.point[0])-x)/safeW,0,1);
          }
          const reference={side:String(chosen.side),ratio:Number(ratio)};
          const point=draftResolvePortReference(box,reference);
          return point?{reference,point:[Number(point[0]),Number(point[1])]}:null;
        };

        // Start-side manual adjustment only. The component port always remains
        // attached to its current component boundary, while dragging this control
        // can ALSO change the length/position of the first orthogonal stub. This
        // makes an outward/inward drag visibly adjust the connection instead of
        // being ignored by the side-lock constraint. No global routing rule is run.
        const moveSourceStartControl=(base,sourceBox,reference,p)=>{
          const points=canonicalRoutePoints(base);
          if(points.length<2||!reference)return clonePoints(points);

          const portPoint=pointOnLockedComponentSide(sourceBox,reference,p);
          if(!portPoint)return clonePoints(points);

          const port=[Number(portPoint[0]),Number(portPoint[1])];
          const target=[
            Number(points[points.length-1][0]),
            Number(points[points.length-1][1])
          ];
          const stageRect=stage.getBoundingClientRect();
          const minStubX=Math.max(0.04,(18/Math.max(1,stageRect.width))*cw);
          const minStubY=Math.max(0.04,(18/Math.max(1,stageRect.height))*ch);
          const side=String(reference.side||"");
          const horizontalSide=side==="left"||side==="right";
          let bendAxis=0;

          if(side==="left"){
            bendAxis=Math.min(Number(p[0]),port[0]-minStubX);
          }else if(side==="right"){
            bendAxis=Math.max(Number(p[0]),port[0]+minStubX);
          }else if(side==="top"){
            bendAxis=Math.min(Number(p[1]),port[1]-minStubY);
          }else if(side==="bottom"){
            bendAxis=Math.max(Number(p[1]),port[1]+minStubY);
          }else{
            return clonePoints(points);
          }

          // A short two/three-point route does not have a spare interior segment
          // that can be shifted without moving the opposite component endpoint.
          // Create one local Manhattan corridor on the source side only.
          if(points.length<=3){
            if(horizontalSide){
              return cleanDraggedRoutePoints([
                port,
                [bendAxis,port[1]],
                [bendAxis,target[1]],
                target
              ]);
            }
            return cleanDraggedRoutePoints([
              port,
              [port[0],bendAxis],
              [target[0],bendAxis],
              target
            ]);
          }

          // For normal multi-segment routes, move the existing first elbow and
          // its immediately adjacent orthogonal segment. The remainder of the
          // route, including the opposite endpoint and arrow geometry, is untouched.
          const result=clonePoints(points);
          result[0]=port;
          if(horizontalSide){
            result[1]=[bendAxis,port[1]];
            result[2][0]=bendAxis;
          }else{
            result[1]=[port[0],bendAxis];
            result[2][1]=bendAxis;
          }
          return cleanDraggedRoutePoints(result);
        };

        // Add-only wrapper for moving the existing source start point to another
        // side of the SAME component. If the pointer remains on the original side,
        // the already-working moveSourceStartControl() path above is used exactly
        // as before. Only a genuine side change uses this local orthogonal prefix.
        const moveSourceStartControlAnySide=(base,sourceBox,initialReference,currentReference,p)=>{
          const selected=sourcePortReferenceAtPointer(
            sourceBox,
            currentReference||initialReference,
            p
          );
          if(!selected){
            return {points:clonePoints(base),reference:currentReference||initialReference};
          }

          const reference=selected.reference;

          // Preserve the complete existing start-point adjustment implementation
          // whenever the handle is still on its original component side.
          if(initialReference&&reference.side===initialReference.side){
            return {
              points:moveSourceStartControl(base,sourceBox,reference,p),
              reference
            };
          }

          const points=canonicalRoutePoints(base);
          if(points.length<2)return {points:clonePoints(points),reference};

          const port=[Number(selected.point[0]),Number(selected.point[1])];
          const stageRect=stage.getBoundingClientRect();
          const minStubX=Math.max(0.04,(18/Math.max(1,stageRect.width))*cw);
          const minStubY=Math.max(0.04,(18/Math.max(1,stageRect.height))*ch);
          const side=String(reference.side||"");
          const horizontalSide=side==="left"||side==="right";
          let bendAxis=0;

          if(side==="left"){
            bendAxis=Math.min(Number(p[0]),port[0]-minStubX);
          }else if(side==="right"){
            bendAxis=Math.max(Number(p[0]),port[0]+minStubX);
          }else if(side==="top"){
            bendAxis=Math.min(Number(p[1]),port[1]-minStubY);
          }else if(side==="bottom"){
            bendAxis=Math.max(Number(p[1]),port[1]+minStubY);
          }else{
            return {points:clonePoints(points),reference};
          }

          // Preserve every downstream vertex exactly. Reconnect only the source
          // port and the local prefix to the existing second interior anchor.
          const anchorIndex=Math.min(2,points.length-1);
          const anchor=[
            Number(points[anchorIndex][0]),
            Number(points[anchorIndex][1])
          ];
          const suffix=clonePoints(points.slice(anchorIndex+1));
          let moved=[];

          if(horizontalSide){
            moved=[
              port,
              [bendAxis,port[1]],
              [bendAxis,anchor[1]],
              anchor,
              ...suffix
            ];
          }else{
            moved=[
              port,
              [port[0],bendAxis],
              [anchor[0],bendAxis],
              anchor,
              ...suffix
            ];
          }

          return {
            points:cleanDraggedRoutePoints(moved),
            reference
          };
        };

        const positionOneTerminalHandle=(handle,isSource)=>{
          const info=terminalSegmentInfo(isSource);
          if(!info){
            handle.style.display="none";
            return;
          }

          handle.style.display="block";
          const ax=Number(info.a[0]),ay=Number(info.a[1]);
          const bx=Number(info.b[0]),by=Number(info.b[1]);
          const horizontal=Math.abs(bx-ax)>=Math.abs(by-ay);

          if(horizontal){
            const left=Math.min(ax,bx);
            const width=Math.abs(bx-ax);
            handle.style.left=`${(left/Math.max(1,cw))*100}%`;
            handle.style.top=`${(ay/Math.max(1,ch))*100}%`;
            handle.style.width=`${(width/Math.max(1,cw))*100}%`;
            handle.style.height="28px";
            handle.style.minWidth="18px";
            handle.style.minHeight="0";
            handle.style.marginLeft="0";
            handle.style.marginTop="-14px";
          }else{
            const top=Math.min(ay,by);
            const height=Math.abs(by-ay);
            handle.style.left=`${(ax/Math.max(1,cw))*100}%`;
            handle.style.top=`${(top/Math.max(1,ch))*100}%`;
            handle.style.width="28px";
            handle.style.height=`${(height/Math.max(1,ch))*100}%`;
            handle.style.minWidth="0";
            handle.style.minHeight="18px";
            handle.style.marginLeft="-14px";
            handle.style.marginTop="0";
          }
        };

        const positionTerminalHandles=()=>{
          positionOneTerminalHandle(sourceTerminalHandle,true);
          positionOneTerminalHandle(targetTerminalHandle,false);
        };
        positionTerminalHandles();

        routeVisuals.set(edgeId,{
          under,line,hit,arrowHandle,positionArrowHandle,
          sourceTerminalHandle,targetTerminalHandle,positionTerminalHandles,
          sourceEndpointHandle,positionSourceEndpointHandle,
          arrowVisual,placeLockedArrow
        });

        const beginTerminalSegmentDrag=(handle,isSource,e)=>{
          if(e.button!==0&&e.pointerType!=="touch"&&e.pointerType!=="pen")return;
          e.preventDefault();
          e.stopPropagation();

          route.points=canonicalRoutePoints(route.points);
          delete route.arrow_control;

          const info=terminalSegmentInfo(isSource);
          if(!info)return;
          const p=rawRouteCanvasPoint(e);

          activeRouteDrag={
            edgeId,
            segment:info.index,
            pointerId:e.pointerId,
            start:[Number(p[0]),Number(p[1])],
            base:clonePoints(route.points),
            lastValidPoints:clonePoints(route.points),
            smoothedPoint:[Number(p[0]),Number(p[1])],
            viaTerminalHandle:true
          };
          handle.style.cursor="grabbing";
          try{handle.setPointerCapture(e.pointerId);}catch(_){}
        };

        sourceTerminalHandle.addEventListener("pointerdown",e=>beginTerminalSegmentDrag(sourceTerminalHandle,true,e));
        targetTerminalHandle.addEventListener("pointerdown",e=>beginTerminalSegmentDrag(targetTerminalHandle,false,e));

        sourceEndpointHandle.addEventListener("pointerdown",e=>{
          if(e.button!==0&&e.pointerType!=="touch"&&e.pointerType!=="pen")return;
          e.preventDefault();
          e.stopPropagation();

          route.points=canonicalRoutePoints(route.points);
          if(route.points.length<2)return;

          const sourceId=String(route.source||"");
          const sourceBox=components[sourceId]?.box||route.source_box;
          if(!Array.isArray(sourceBox)||sourceBox.length!==4)return;

          const sourceRef=draftPortReference(sourceBox,route.points[0]);
          if(!sourceRef)return;

          const p=rawRouteCanvasPoint(e);
          activeRouteDrag={
            edgeId,
            pointerId:e.pointerId,
            start:[Number(p[0]),Number(p[1])],
            base:clonePoints(route.points),
            lastValidPoints:clonePoints(route.points),
            viaSourceEndpointHandle:true,
            sourceBox:cloneBox(sourceBox),
            sourcePortReference:{side:String(sourceRef.side),ratio:Number(sourceRef.ratio)},
            initialSourcePortReference:{side:String(sourceRef.side),ratio:Number(sourceRef.ratio)},
            grabOffset:[
              Number(route.points[0][0])-Number(p[0]),
              Number(route.points[0][1])-Number(p[1])
            ]
          };
          sourceEndpointHandle.style.cursor="grabbing";
          try{sourceEndpointHandle.setPointerCapture(e.pointerId);}catch(_){}
        });

        arrowHandle.addEventListener("pointerdown",e=>{
          if(e.button!==0&&e.pointerType!=="touch"&&e.pointerType!=="pen")return;
          e.preventDefault();
          e.stopPropagation();

          route.points=canonicalRoutePoints(route.points);
          delete route.arrow_control;

          // Arrow-drag adjustment only. Treat the existing orange arrow as the
          // draggable terminal endpoint. The opposite connection geometry stays
          // untouched, while the terminal orthogonal section follows the arrow.
          // Arrow appearance/direction logic is not changed here.
          const arrowGeometry=fixedArrowGeometry(route);
          const arrowProfile=arrowGeometry
            ? arrowDragProfile(route,arrowGeometry)
            : null;
          if(!arrowGeometry||!arrowProfile)return;

          const direction=String(route.original_direction||route.direction||"source_to_target");
          const isStart=direction==="target_to_source";
          const terminalSegment=isStart?0:Math.max(0,route.points.length-2);
          const pointerPoint=rawRouteCanvasPoint(e);

          activeRouteDrag={
            edgeId,
            segment:terminalSegment,
            pointerId:e.pointerId,
            start:[Number(pointerPoint[0]),Number(pointerPoint[1])],
            base:clonePoints(route.points),
            lastValidPoints:clonePoints(route.points),
            smoothedPoint:[Number(pointerPoint[0]),Number(pointerPoint[1])],
            viaArrowHandle:true,
            arrowGeometry,
            arrowProfile,
            grabOffset:[
              Number(arrowGeometry.originalTip[0])-Number(pointerPoint[0]),
              Number(arrowGeometry.originalTip[1])-Number(pointerPoint[1])
            ]
          };
          arrowHandle.style.cursor="grabbing";
          try{arrowHandle.setPointerCapture(e.pointerId);}catch(_){}
        });

        const openThisRouteMenu=e=>{
          e.preventDefault();
          e.stopPropagation();
          openRenderedRouteMenu(e.clientX,e.clientY,edgeId);
        };
        hit.addEventListener("contextmenu",openThisRouteMenu);
        arrowHandle.addEventListener("contextmenu",openThisRouteMenu);
        sourceTerminalHandle.addEventListener("contextmenu",openThisRouteMenu);
        targetTerminalHandle.addEventListener("contextmenu",openThisRouteMenu);
        sourceEndpointHandle.addEventListener("contextmenu",openThisRouteMenu);

        hit.addEventListener("click",e=>{
          e.preventDefault();
          e.stopPropagation();
          if(dragOnlyRouteAction)dragOnlyRouteAction.select(edgeId);
        });

        hit.addEventListener("pointerdown",e=>{
          if(e.button!==0&&e.pointerType!=="touch"&&e.pointerType!=="pen")return;
          e.preventDefault();
          e.stopPropagation();

          if(dragOnlyRouteAction)dragOnlyRouteAction.select(edgeId);

          const p=rawRouteCanvasPoint(e);

          updateRouteVisual(edgeId);

          const segment=nearestSegment(route.points,p).index;
          activeRouteDrag={
            edgeId,
            segment,
            pointerId:e.pointerId,
            start:[Number(p[0]),Number(p[1])],
            base:clonePoints(route.points),
            lastValidPoints:clonePoints(route.points),
            smoothedPoint:[Number(p[0]),Number(p[1])]
          };
          hit.style.cursor="grabbing";
          try{hit.setPointerCapture(e.pointerId);}catch(_){}
        });

        const applyActiveRouteMove=eventLike=>{
          if(
            !activeRouteDrag ||
            activeRouteDrag.pointerId!==eventLike.pointerId ||
            activeRouteDrag.edgeId!==edgeId
          )return;

          const p=rawRouteCanvasPoint(eventLike);
          if(activeRouteDrag.viaArrowHandle){
            moveRouteFromArrowHandle(route,activeRouteDrag,p);
          }else if(activeRouteDrag.viaSourceEndpointHandle){
            const grabOffset=Array.isArray(activeRouteDrag.grabOffset)
              ? activeRouteDrag.grabOffset
              : [0,0];
            const adjustedPointer=[
              Number(p[0])+Number(grabOffset[0]||0),
              Number(p[1])+Number(grabOffset[1]||0)
            ];
            const adjusted=moveSourceStartControlAnySide(
              activeRouteDrag.base,
              activeRouteDrag.sourceBox,
              activeRouteDrag.initialSourcePortReference,
              activeRouteDrag.sourcePortReference,
              adjustedPointer
            );
            route.points=adjusted.points;
            activeRouteDrag.sourcePortReference=adjusted.reference;
            activeRouteDrag.lastValidPoints=clonePoints(route.points);
          }else{
            moveRouteSegment(route,activeRouteDrag,p);
          }

          // Keep the existing dynamic arrow-orientation behavior unchanged.
          refreshArrowAngleFromCurrentGeometry(route);
          // Do not rebuild/remove SVG nodes during a drag. Updating the existing
          // DOM nodes preserves pointer capture and gives a continuous free drag.
          updateRouteVisual(edgeId);
        };

        const routePointerQueue=createRafPointerQueue(applyActiveRouteMove);

        const moveActiveRoute=e=>{
          if(
            !activeRouteDrag ||
            activeRouteDrag.pointerId!==e.pointerId ||
            activeRouteDrag.edgeId!==edgeId
          )return;
          e.preventDefault();
          e.stopPropagation();
          routePointerQueue.push(e);
        };

        hit.addEventListener("pointermove",moveActiveRoute);
        arrowHandle.addEventListener("pointermove",moveActiveRoute);
        sourceTerminalHandle.addEventListener("pointermove",moveActiveRoute);
        targetTerminalHandle.addEventListener("pointermove",moveActiveRoute);
        sourceEndpointHandle.addEventListener("pointermove",moveActiveRoute);
        routeSvg.addEventListener("pointermove",moveActiveRoute);
        addDragOnlyWindowListener("pointermove",moveActiveRoute);

        const finishRouteDrag=e=>{
          if(!activeRouteDrag||activeRouteDrag.pointerId!==e.pointerId||activeRouteDrag.edgeId!==edgeId)return;
          e.preventDefault();
          e.stopPropagation();

          // Apply the latest pointer coordinate before committing so a quick
          // pointer-up cannot lose the final sub-frame movement.
          routePointerQueue.flush(e);

          const before=activeRouteDrag.base;
          route.points=cleanDraggedRoutePoints(route.points);
          const moved=JSON.stringify(before)!==JSON.stringify(route.points);
          activeRouteDrag=null;
          hit.style.cursor="grab";
          arrowHandle.style.cursor="grab";
          sourceTerminalHandle.style.cursor="grab";
          targetTerminalHandle.style.cursor="grab";
          sourceEndpointHandle.style.cursor="grab";
          try{hit.releasePointerCapture(e.pointerId);}catch(_){}
          try{arrowHandle.releasePointerCapture(e.pointerId);}catch(_){}
          try{sourceTerminalHandle.releasePointerCapture(e.pointerId);}catch(_){}
          try{targetTerminalHandle.releasePointerCapture(e.pointerId);}catch(_){}
          try{sourceEndpointHandle.releasePointerCapture(e.pointerId);}catch(_){}
          if(moved){
            route.manual_drag=true;
            // Persist the adjusted connection back to Streamlit on pointer-up.
            // The existing Python handler stores the exact route points as a
            // manual override, so the line no longer snaps back after any rerun,
            // component update, worksheet refresh, or export preparation.
            // During pointer movement the drag remains fully browser-local for
            // smooth interaction; only the final dropped geometry is committed.
            saveMovementDraft();
            emit("connection_route_move",{
              edge_id:edgeId,
              points:clonePoints(route.points),
              arrow_control:Array.isArray(route.arrow_control)
                ?[Number(route.arrow_control[0]),Number(route.arrow_control[1])]
                :null
            });
            applyClickedOhtSensorEmbeds();
          }
        };
        hit.addEventListener("pointerup",finishRouteDrag);
        hit.addEventListener("pointercancel",finishRouteDrag);
        arrowHandle.addEventListener("pointerup",finishRouteDrag);
        arrowHandle.addEventListener("pointercancel",finishRouteDrag);
        sourceTerminalHandle.addEventListener("pointerup",finishRouteDrag);
        sourceTerminalHandle.addEventListener("pointercancel",finishRouteDrag);
        targetTerminalHandle.addEventListener("pointerup",finishRouteDrag);
        targetTerminalHandle.addEventListener("pointercancel",finishRouteDrag);
        sourceEndpointHandle.addEventListener("pointerup",finishRouteDrag);
        sourceEndpointHandle.addEventListener("pointercancel",finishRouteDrag);
        routeSvg.addEventListener("pointerup",finishRouteDrag);
        addDragOnlyWindowListener("pointerup",finishRouteDrag);
        addDragOnlyWindowListener("pointercancel",finishRouteDrag);
      }

      // Right-click uses the geometry drawn on this pass. The first and last
      // segments sit under drag handles, so the menu is also opened from the
      // pointer position against those original points.
      const routeIdAtClient=(clientX,clientY)=>{
        const rect=stage.getBoundingClientRect();
        if(!rect.width||!rect.height)return "";
        const px=(clientX-rect.left)/rect.width*cw;
        const py=(clientY-rect.top)/rect.height*ch;
        let bestId="";
        let bestPx=17;
        for(const route of Object.values(routes)){
          if(!route||route.hidden)continue;
          const pts=Array.isArray(route.points)?route.points:[];
          for(let i=0;i<pts.length-1;i++){
            const a=pts[i],b=pts[i+1];
            if(!a||!b)continue;
            const ax=Number(a[0]),ay=Number(a[1]),bx=Number(b[0]),by=Number(b[1]);
            const vx=bx-ax,vy=by-ay;
            const len2=vx*vx+vy*vy;
            if(len2<1e-12)continue;
            let t=((px-ax)*vx+(py-ay)*vy)/len2;
            if(t<0)t=0;
            else if(t>1)t=1;
            const qx=ax+t*vx,qy=ay+t*vy;
            const dist=Math.hypot((qx-px)/cw*rect.width,(qy-py)/ch*rect.height);
            if(dist<bestPx){
              bestPx=dist;
              bestId=String(route.edge_id||"");
            }
          }
        }
        return bestPx<=16?bestId:"";
      };
      stage.addEventListener("contextmenu",event=>{
        const target=event.target;
        if(!target)return;
        const tag=String(target.tagName||"").toUpperCase();
        if(tag==="BUTTON"||tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT")return;
        if(typeof target.closest==="function"&&target.closest("[data-component-id],[data-annotation-id]"))return;
        const edgeId=routeIdAtClient(event.clientX,event.clientY);
        if(!edgeId)return;
        event.preventDefault();
        event.stopPropagation();
        openRenderedRouteMenu(event.clientX,event.clientY,edgeId);
      },true);
    };
    drawDragOnlyRoutes();

    const pendingId=String(argsState.pending_connection_source_id||"");
    let activeDrag=null;
    const hoverTimers=new Map();
    const overlays=new Map();
    const componentLabels=new Map();
    const componentVisuals=new Map();
    let activeLabelEditor=null;

    // Presentation only: acronym boxes hide the under-component title label;
    // graphic icons keep it. Does not move boxes or touch routes.
    const applyComponentLabelVisibility=(labelPair,component)=>{
      if(!labelPair)return;
      const show=componentDisplayMode(component)!=="acronyms";
      const display=show?"":"none";
      if(labelPair.main){
        labelPair.main.style.display=display;
        labelPair.main.style.visibility=show?"visible":"hidden";
      }
      if(labelPair.under){
        labelPair.under.style.display=display;
        labelPair.under.style.visibility=show?"visible":"hidden";
      }
    };

    const finishLabelEdit=(save=true)=>{
      if(!activeLabelEditor)return;
      const editor=activeLabelEditor;
      activeLabelEditor=null;
      const next=String(editor.input.value||"").trim();
      editor.input.remove();
      if(save&&next&&next!==editor.original){
        editor.component.title=next;
        editor.component.label=next;
        editor.component.acronym=next;
        editor.labelPair.main.textContent=next;
        editor.labelPair.under.textContent=next;
        emit("component_label_edit",{
          instance_id:editor.id,
          title:next,
          label:next,
          acronym:next
        });
      }
      applyComponentLabelVisibility(editor.labelPair,editor.component);
    };

    const beginLabelEdit=(id,labelPair,event)=>{
      if(activeLabelEditor)finishLabelEdit(true);
      const component=components[id];
      if(!component||!labelPair)return;
      // Acronym mode has no under-box label to edit.
      if(componentDisplayMode(component)==="acronyms")return;
      const input=document.createElement("input");
      input.type="text";
      input.value=String(component.title||component.component||id);
      input.setAttribute("aria-label","Component label");
      input.style.cssText="position:absolute;z-index:90;box-sizing:border-box;min-width:80px;padding:2px 5px;border:1px solid #0a66e3;border-radius:3px;background:#fff;color:#173f75;font:700 16px Arial,sans-serif;text-align:center;transform:translateX(-50%);outline:none;";
      const [x,y,w,h]=cloneBox(component.box);
      input.style.left=toPercent(x+(w/2),cw);
      input.style.top=toPercent(y+h+0.12,ch);
      input.style.width=`${Math.max(80,Math.min(280,(String(input.value).length+4)*9))}px`;
      stage.appendChild(input);
      labelPair.main.style.display="none";
      labelPair.under.style.display="none";
      activeLabelEditor={id,component,labelPair,input,original:input.value};
      input.addEventListener("pointerdown",e=>e.stopPropagation());
      input.addEventListener("keydown",e=>{
        if(e.key==="Enter"){e.preventDefault();finishLabelEdit(true);}
        if(e.key==="Escape"){e.preventDefault();finishLabelEdit(false);}
      });
      input.addEventListener("blur",()=>finishLabelEdit(true));
      input.focus({preventScroll:true});
      input.select();
      event?.stopPropagation();
      event?.preventDefault();
    };

    // Touch reveal persistence survives a Streamlit component re-render caused
    // by the existing component-select event, so a finger tap still keeps the
    // Add/Delete controls visible for the full 2-second window.
    const hoverRevealStorageKey=()=>{
      const key=String(argsState.local_draft_key||"").trim();
      return key?`rts:hover-controls:${key}`:"rts:hover-controls:worksheet";
    };
    const readHoverReveals=()=>{
      try{
        const raw=sessionStorage.getItem(hoverRevealStorageKey());
        const parsed=JSON.parse(raw||"{}");
        return parsed&&typeof parsed==="object"?parsed:{};
      }catch(_){
        return {};
      }
    };
    const writeHoverReveals=(value)=>{
      try{
        sessionStorage.setItem(hoverRevealStorageKey(),JSON.stringify(value||{}));
      }catch(_){}
    };

    const toPercent=(v,total)=>`${(Number(v||0)/Math.max(1,total))*100}%`;

    const applyBox=(el,box)=>{
      const [x,y,w,h]=cloneBox(box);
      el.style.left=toPercent(x,cw);
      el.style.top=toPercent(y,ch);
      el.style.width=toPercent(w,cw);
      el.style.height=toPercent(h,ch);
    };

    // Component-image visibility only.
    // Keep the logical component box completely unchanged for labels, hit areas,
    // drag/drop coordinates, route endpoints and saved layout. Only the visible
    // <img> is clamped inside the Worksheet viewport so an image can never be
    // cut off by the stage's overflow:hidden boundary.
    const visibleComponentImageBox=(box)=>{
      const [x,y,w,h]=cloneBox(box);

      // Component-image visibility only.
      // Convert a real screen-pixel safety inset into diagram units so the
      // visible image is always clearly inside the Worksheet on every screen
      // size. The logical component box itself is NOT changed.
      const stageRect=stage.getBoundingClientRect();
      const safetyPx=18;
      const marginX=Math.max(
        0.02,
        (safetyPx/Math.max(1,stageRect.width))*cw
      );
      const marginY=Math.max(
        0.02,
        (safetyPx/Math.max(1,stageRect.height))*ch
      );

      const maxVisibleW=Math.max(0.01,cw-(marginX*2));
      const maxVisibleH=Math.max(0.01,ch-(marginY*2));

      let visibleW=Math.max(0.01,w);
      let visibleH=Math.max(0.01,h);

      // If a component image is ever larger than the safe visible Worksheet
      // area, scale only the visible image down proportionally. Do not modify
      // the component's logical geometry, labels, routes or interaction data.
      if(visibleW>maxVisibleW||visibleH>maxVisibleH){
        const scale=Math.min(
          maxVisibleW/Math.max(0.01,visibleW),
          maxVisibleH/Math.max(0.01,visibleH)
        );
        visibleW*=scale;
        visibleH*=scale;
      }

      const maxX=Math.max(marginX,cw-marginX-visibleW);
      const maxY=Math.max(marginY,ch-marginY-visibleH);

      return[
        clamp(x,marginX,maxX),
        clamp(y,marginY,maxY),
        visibleW,
        visibleH
      ];
    };

    const applyVisibleComponentImageBox=(el,box)=>{
      applyBox(el,visibleComponentImageBox(box));
      if(el&&el.classList&&el.classList.contains("component-acronym-box")){
        // Measure the laid-out box so font tracks live resize in CSS pixels.
        fitAcronymBoxFont(el,box);
      }
    };

    const canvasPointFromClient=(clientX,clientY)=>{
      const r=stage.getBoundingClientRect();
      if(!r.width||!r.height)return null;
      return[
        clamp((Number(clientX)-r.left)/r.width*cw,0,cw),
        clamp((Number(clientY)-r.top)/r.height*ch,0,ch)
      ];
    };
    const canvasPoint=(ev)=>{
      return canvasPointFromClient(ev&&ev.clientX,ev&&ev.clientY)||[0,0];
    };

    // Manual Draw stays in the browser until a line is finished. Toggling the
    // mode does not notify Streamlit, so opening it does not reroute the sheet.
    const manualDraw={enabled:false,source:"",points:[]};
    const manualPreview=document.createElementNS("http://www.w3.org/2000/svg","svg");
    manualPreview.setAttribute("viewBox",`0 0 ${cw} ${ch}`);
    manualPreview.setAttribute("preserveAspectRatio","none");
    manualPreview.style.cssText="position:absolute;inset:0;width:100%;height:100%;z-index:6;pointer-events:none;overflow:visible;";
    stage.appendChild(manualPreview);
    const manualPreviewLine=document.createElementNS("http://www.w3.org/2000/svg","polyline");
    manualPreviewLine.setAttribute("fill","none");
    manualPreviewLine.setAttribute("stroke","#0a66e3");
    manualPreviewLine.setAttribute("stroke-width","0.018");
    manualPreviewLine.setAttribute("stroke-dasharray","0.05 0.04");
    manualPreviewLine.setAttribute("stroke-linejoin","round");
    manualPreviewLine.setAttribute("stroke-linecap","round");
    manualPreview.appendChild(manualPreviewLine);

    const portFacingPoint=(box,point)=>{
      const x=Number(box[0]),y=Number(box[1]),w=Number(box[2]),h=Number(box[3]);
      const cx=x+w/2,cy=y+h/2;
      const dx=Number(point[0])-cx,dy=Number(point[1])-cy;
      if(Math.abs(dx)>=Math.abs(dy))return dx>=0?[x+w,cy]:[x,cy];
      return dy>=0?[cx,y+h]:[cx,y];
    };
    const elbowBetween=(fromBox,toBox)=>{
      const start=portFacingPoint(fromBox,[toBox[0]+toBox[2]/2,toBox[1]+toBox[3]/2]);
      const end=portFacingPoint(toBox,[fromBox[0]+fromBox[2]/2,fromBox[1]+fromBox[3]/2]);
      if(Math.abs(start[0]-end[0])<0.02||Math.abs(start[1]-end[1])<0.02)return [start,end];
      const horizontalExit=Math.abs(start[0]-(fromBox[0]+fromBox[2]/2))>=Math.abs(start[1]-(fromBox[1]+fromBox[3]/2));
      return horizontalExit?[start,[end[0],start[1]],end]:[start,[start[0],end[1]],end];
    };
    const pushOrtho=(points,point)=>{
      if(!points.length){points.push([Number(point[0]),Number(point[1])]);return;}
      const prev=points[points.length-1];
      const dx=Math.abs(point[0]-prev[0]),dy=Math.abs(point[1]-prev[1]);
      if(dx<0.02&&dy<0.02)return;
      let next;
      if(points.length>=2){
        const before=points[points.length-2];
        const lastHorizontal=Math.abs(prev[0]-before[0])>=Math.abs(prev[1]-before[1]);
        next=lastHorizontal?[prev[0],point[1]]:[point[0],prev[1]];
      }else{
        next=dx>=dy?[point[0],prev[1]]:[prev[0],point[1]];
      }
      if(Math.hypot(next[0]-prev[0],next[1]-prev[1])<0.02)return;
      points.push(next);
    };
    const waterNames=new Set(["Sump","OHT Tank","Bore Well","Well"]);
    const pairIsWater=(fromId,toId)=>{
      const sourceComp=components[fromId]||{component:""};
      const targetComp=components[toId]||{component:""};
      const sourceName=String(sourceComp.component||"");
      const targetName=String(targetComp.component||"");
      if(waterNames.has(sourceName)&&waterNames.has(targetName))return true;
      const sourceWater=waterNames.has(sourceName);
      const targetWater=waterNames.has(targetName);
      const sourceInline=isInlineProcessComponent(sourceComp);
      const targetInline=isInlineProcessComponent(targetComp);
      return (sourceWater&&targetInline)||(sourceInline&&targetWater);
    };
    const showManualPreview=(extra)=>{
      const pts=manualDraw.points.map(p=>[p[0],p[1]]);
      if(extra)pushOrtho(pts,extra);
      const sourceName=String(components[manualDraw.source]?.component||"");
      const waterStart=waterNames.has(sourceName);
      manualPreviewLine.setAttribute("stroke",waterStart?"#123DBD":"#000000");
      if(waterStart)manualPreviewLine.removeAttribute("stroke-dasharray");
      else manualPreviewLine.setAttribute("stroke-dasharray","0.026 0.052");
      manualPreviewLine.setAttribute("points",pts.map(p=>`${p[0]},${p[1]}`).join(" "));
    };
    const highlightManualSource=(id)=>{
      for(const [cid,item] of overlays){
        if(!item||!item.hit)continue;
        item.hit.style.outline=cid===id?"3px solid #0a66e3":"none";
        item.hit.style.outlineOffset=cid===id?"2px":"0";
      }
    };
    manualDraw.cancel=()=>{
      manualDraw.source="";
      manualDraw.points=[];
      manualPreviewLine.setAttribute("points","");
      highlightManualSource("");
    };
    worksheetTools.setManualDraw=(enabled)=>{
      const next=!!enabled;
      const changed=manualDraw.enabled!==next;
      manualDraw.enabled=next;
      stage.style.cursor=next?"crosshair":"";
      if(changed&&!next)manualDraw.cancel();
    };
    worksheetTools.setManualDraw(!!argsState.manual_draw);
    manualDraw.commit=(sourceId,targetId,points)=>{
      const clean=clonePoints(points).filter(p=>Array.isArray(p)&&p.length>=2);
      if(clean.length<2){manualDraw.cancel();return;}
      const fromId=String(sourceId||"");
      const toId=String(targetId||"");
      const waterLine=pairIsWater(fromId,toId);
      const stroke=waterLine?"#123DBD":"#000000";
      const existing=Object.values(routes).find(route=>!route.hidden&&fromId&&toId&&(
        (String(route.source||"")===fromId&&String(route.target||"")===toId)||
        (String(route.source||"")===toId&&String(route.target||"")===fromId)
      ));
      const edgeId=existing
        ?String(existing.edge_id||existing.id||"")
        :`manual__${eid()}`;
      if(existing){
        existing.points=clean;
        existing.original_points=clonePoints(clean);
        existing.dotted=!waterLine;
        existing.color=stroke;
        existing.custom=true;
        existing.manual_drag=true;
        existing.stored_geometry=true;
        existing.hidden=false;
        existing.sourceHandle=existing.sourceHandle||existing.source_handle||`${fromId}:auto`;
        existing.targetHandle=existing.targetHandle||existing.target_handle||`${toId}:auto`;
        existing.source_handle=existing.sourceHandle;
        existing.target_handle=existing.targetHandle;
        updateRouteVisual(edgeId);
        const visual=routeVisuals.get(edgeId);
        if(visual&&visual.line){
          visual.line.setAttribute("stroke",stroke);
          if(waterLine)visual.line.removeAttribute("stroke-dasharray");
          else visual.line.setAttribute("stroke-dasharray","0.026 0.052");
        }
      }else{
        routes[edgeId]={
          edge_id:edgeId,
          id:edgeId,
          points:clean,
          original_points:clonePoints(clean),
          source:fromId,
          target:toId,
          sourceHandle:`${fromId}:auto`,
          targetHandle:`${toId}:auto`,
          source_handle:`${fromId}:auto`,
          target_handle:`${toId}:auto`,
          color:stroke,
          dotted:!waterLine,
          direction:"source_to_target",
          original_direction:"source_to_target",
          hidden:false,
          custom:true,
          manual_drag:true,
          stored_geometry:true
        };
        const drawn=clean.map(p=>`${p[0]},${p[1]}`).join(" ");
        const strokeUnder=routeEl("polyline",{
          points:drawn,fill:"none",stroke:"#ffffff","stroke-width":"0.030",
          "stroke-linejoin":"round","stroke-linecap":"round","pointer-events":"none"
        });
        const strokeLine=routeEl("polyline",{
          points:drawn,fill:"none",stroke:stroke,"stroke-width":"0.015",
          "stroke-linejoin":"round","stroke-linecap":"round","pointer-events":"none"
        });
        if(!waterLine)strokeLine.setAttribute("stroke-dasharray","0.026 0.052");
        strokeUnder.setAttribute("data-manual-stroke","1");
        strokeLine.setAttribute("data-manual-stroke","1");
        routeSvg.appendChild(strokeUnder);
        routeSvg.appendChild(strokeLine);
      }
      manualDraw.cancel();
      saveMovementDraft();
      emit("manual_draw_commit",{
        edge_id:edgeId,
        source:String(sourceId||""),
        target:String(targetId||""),
        points:clonePoints(clean)
      });
    };
    manualDraw.handleComponent=(id)=>{
      if(!manualDraw.enabled)return false;
      const target=components[id];
      if(!target||target.hidden)return true;
      if(manualDraw.points.length){
        const port=portFacingPoint(target.box,manualDraw.points[manualDraw.points.length-1]);
        pushOrtho(manualDraw.points,port);
        const last=manualDraw.points[manualDraw.points.length-1];
        if(Math.hypot(last[0]-port[0],last[1]-port[1])>0.02)manualDraw.points.push(port);
        manualDraw.commit(manualDraw.source,id,manualDraw.points);
        return true;
      }
      if(!manualDraw.source){
        manualDraw.source=id;
        highlightManualSource(id);
        return true;
      }
      if(manualDraw.source===id){
        manualDraw.cancel();
        return true;
      }
      const source=components[manualDraw.source];
      if(!source){manualDraw.cancel();return true;}
      manualDraw.commit(manualDraw.source,id,elbowBetween(source.box,target.box));
      return true;
    };
    stage.addEventListener("pointerdown",event=>{
      if(!manualDraw.enabled)return;
      if(event.button!==0&&event.pointerType!=="touch"&&event.pointerType!=="pen")return;
      if(event.target&&event.target.closest&&event.target.closest("[data-manual-draw-ui],[data-component-id],[data-annotation-id]"))return;
      const tag=String(event.target&&event.target.tagName||"").toLowerCase();
      if(tag==="polyline"||tag==="path")return;
      const point=canvasPoint(event);
      if(manualDraw.source&&!manualDraw.points.length){
        const source=components[manualDraw.source];
        if(source)manualDraw.points.push(portFacingPoint(source.box,point));
      }
      pushOrtho(manualDraw.points,point);
      showManualPreview();
    });
    stage.addEventListener("pointermove",event=>{
      if(!manualDraw.enabled||!manualDraw.points.length)return;
      showManualPreview(canvasPoint(event));
    });
    stage.addEventListener("dblclick",event=>{
      if(!manualDraw.enabled)return;
      if(event.target&&event.target.closest&&event.target.closest("[data-manual-draw-ui],[data-component-id],[data-annotation-id]"))return;
      event.preventDefault();
      event.stopPropagation();
      if(manualDraw.points.length>=2){
        manualDraw.commit(manualDraw.source,"",manualDraw.points);
      }
    });
    addDragOnlyWindowListener("keydown",event=>{
      if(!manualDraw.enabled||event.key!=="Escape")return;
      event.preventDefault();
      manualDraw.cancel();
    });

    const makeGhostFromPreview=(component)=>{
      if(componentDisplayMode(component)==="acronyms"){
        const ghost=document.createElement("div");
        ghost.className="component-acronym-box";
        ghost.textContent=componentAcronymText(component);
        ghost.style.cssText="position:absolute;z-index:40;pointer-events:none;user-select:none;filter:drop-shadow(0 5px 8px rgba(0,0,0,.18));";
        applyVisibleComponentImageBox(ghost,component.box);
        return ghost;
      }
      const ghost=document.createElement("img");
      ghost.draggable=false;
      ghost.style.cssText="position:absolute;z-index:40;pointer-events:none;user-select:none;object-fit:contain;filter:drop-shadow(0 5px 8px rgba(0,0,0,.18));";
      applyVisibleComponentImageBox(ghost,component.box);

      const directSrc=String(component.image_b64||"").trim();
      if(directSrc){
        ghost.src=`data:image/png;base64,${directSrc}`;
      }else{
        ghost.src=`data:image/png;base64,${argsState.image_b64||""}`;
        ghost.style.objectFit="fill";
      }
      return ghost;
    };

    // Acronym corner resize grips sit at NW/NE; keep + / × on a top action
    // dock so they stay visible and clickable without switching back to icons.
    const layoutComponentActionControls=(addBtn,delBtn,component)=>{
      const acronym=componentDisplayMode(component)==="acronyms";
      if(addBtn){
        addBtn.style.zIndex="46";
        if(acronym){
          addBtn.style.left="calc(50% + 4px)";
          addBtn.style.right="auto";
          addBtn.style.top="-38px";
          addBtn.style.transform="none";
        }else{
          addBtn.style.left="auto";
          addBtn.style.right="-13px";
          addBtn.style.top="-13px";
          addBtn.style.transform="none";
        }
      }
      if(delBtn){
        delBtn.style.zIndex="46";
        if(acronym){
          delBtn.style.left="calc(50% - 34px)";
          delBtn.style.right="auto";
          delBtn.style.top="-38px";
          delBtn.style.transform="none";
        }else{
          delBtn.style.left="-13px";
          delBtn.style.right="auto";
          delBtn.style.top="-13px";
          delBtn.style.transform="none";
        }
      }
    };

    const setComponentControlsVisible=(id,visible)=>{
      const item=overlays.get(String(id||""));
      if(!item)return;
      if(item.add){
        item.add.style.opacity=visible?"1":"0";
        item.add.style.pointerEvents=visible?"auto":"none";
      }
      if(item.del){
        item.del.style.opacity=visible?"1":"0";
        item.del.style.pointerEvents=visible?"auto":"none";
      }
      if(item.modeSelect){
        item.modeSelect.style.opacity=visible?"1":"0";
        item.modeSelect.style.pointerEvents=visible?"auto":"none";
      }
      if(item.resizeHandles&&item.resizeHandles.length){
        for(const handle of item.resizeHandles){
          handle.style.opacity=visible?"1":"0";
          handle.style.pointerEvents=visible?"auto":"none";
        }
      }
    };

    const ACRONYM_MIN_W=0.32;
    const ACRONYM_MIN_H=0.24;
    const ACRONYM_MAX_W=2.8;
    const ACRONYM_MAX_H=2.2;
    const resizeAcronymBox=(baseBox,corner,dx,dy)=>{
      let [x,y,w,h]=cloneBox(baseBox);
      if(corner==="se"){
        w=clamp(w+dx,ACRONYM_MIN_W,ACRONYM_MAX_W);
        h=clamp(h+dy,ACRONYM_MIN_H,ACRONYM_MAX_H);
      }else if(corner==="sw"){
        w=clamp(w-dx,ACRONYM_MIN_W,ACRONYM_MAX_W);
        h=clamp(h+dy,ACRONYM_MIN_H,ACRONYM_MAX_H);
        x=baseBox[0]+baseBox[2]-w;
      }else if(corner==="ne"){
        w=clamp(w+dx,ACRONYM_MIN_W,ACRONYM_MAX_W);
        h=clamp(h-dy,ACRONYM_MIN_H,ACRONYM_MAX_H);
        y=baseBox[1]+baseBox[3]-h;
      }else{
        w=clamp(w-dx,ACRONYM_MIN_W,ACRONYM_MAX_W);
        h=clamp(h-dy,ACRONYM_MIN_H,ACRONYM_MAX_H);
        x=baseBox[0]+baseBox[2]-w;
        y=baseBox[1]+baseBox[3]-h;
      }
      return[x,y,w,h];
    };

    const clearComponentHoverTimer=(id)=>{
      const key=String(id||"");
      const timer=hoverTimers.get(key);
      if(timer!==undefined){
        clearTimeout(timer);
        hoverTimers.delete(key);
      }
    };

    // Required timing:
    // - appear immediately on hover/touch
    // - stay visible for the complete 2 seconds even after the pointer leaves
    // - disappear automatically after that 2-second window
    // Each component has its own timer, so moving to another component does not
    // prematurely hide the controls that are already visible on the first one.
    const showControlsForTwoSeconds=(id,{persist=false,remainingMs=2000}={})=>{
      const key=String(id||"");
      if(!key)return;

      clearComponentHoverTimer(key);
      setComponentControlsVisible(key,true);

      const duration=Math.max(1,Math.min(2000,Number(remainingMs)||2000));
      const expiresAt=Date.now()+duration;

      if(persist){
        const reveals=readHoverReveals();
        reveals[key]=expiresAt;
        writeHoverReveals(reveals);
      }

      const timer=setTimeout(()=>{
        hoverTimers.delete(key);
        setComponentControlsVisible(key,false);

        const reveals=readHoverReveals();
        if(Object.prototype.hasOwnProperty.call(reveals,key)){
          delete reveals[key];
          writeHoverReveals(reveals);
        }
      },duration);

      hoverTimers.set(key,timer);
    };

    const restorePersistedHoverReveals=()=>{
      const reveals=readHoverReveals();
      const now=Date.now();
      let changed=false;

      for(const [id,rawExpiry] of Object.entries(reveals)){
        const expiry=Number(rawExpiry)||0;
        const remaining=expiry-now;
        if(remaining>0 && overlays.has(id)){
          showControlsForTwoSeconds(id,{persist:false,remainingMs:remaining});
        }else{
          delete reveals[id];
          changed=true;
        }
      }

      if(changed)writeHoverReveals(reveals);
    };

    const paintOrder=Object.values(components).slice().sort(
      (a,b)=>componentStackLayer(a)-componentStackLayer(b)
    );
    for(const c of paintOrder){
      if(c.hidden)continue;
      const id=String(c.instance_id||"");
      if(!id)continue;
      const visualZ=c.__oht_attached_sensor?19:(isPrimaryCanvasComponent(c)?15:28);
      const hitZ=isPrimaryCanvasComponent(c)?46:58;

      // Actual visible component layer. This is deliberately separate from the
      // transparent pointer target so the component itself moves immediately.
      // Secondary cards sit above Sump, Bore Well, and OHT Tank so a tank image
      // cannot cover them or steal their drag target.
      let visual;
      if(componentDisplayMode(c)==="acronyms"){
        visual=document.createElement("div");
        visual.className="component-acronym-box";
        visual.textContent=componentAcronymText(c);
        visual.title=String(c.title||c.component||id);
        visual.style.cssText=`position:absolute;z-index:${visualZ};pointer-events:none;user-select:none;`;
        applyVisibleComponentImageBox(visual,c.box);
      }else{
        visual=document.createElement("img");
        visual.draggable=false;
        visual.alt=String(c.title||c.component||id);
        visual.src=`data:image/png;base64,${String(c.image_b64||"").trim()}`;
        visual.style.cssText=`position:absolute;z-index:${visualZ};pointer-events:none;user-select:none;object-fit:${String(c.image_fit||"contain")};`;
        if(c.__oht_attached_sensor)revealInternalSensorGlyph(visual);
        applyVisibleComponentImageBox(visual,c.box);
      }
      stage.appendChild(visual);
      if(visual.classList&&visual.classList.contains("component-acronym-box")){
        fitAcronymBoxFont(visual,c.box);
      }
      componentVisuals.set(id,visual);

      // The OHT-associated LLS is part of the tank presentation only: no
      // standalone label, +/- controls, delete control or independent drag box.
      if(c.__oht_attached_sensor)continue;

      let wifiBadge=null;
      let suppressComponentClick=false;
      const positionWifiBadge=()=>{
        if(!wifiBadge)return;
        const [wx,wy,ww,wh]=cloneBox(c.box);
        wifiBadge.style.left=toPercent(wx+(ww/2),cw);
        wifiBadge.style.top=toPercent(wy,ch);
      };
      if(Boolean(c.wireless)){
        wifiBadge=document.createElement("div");
        wifiBadge.setAttribute("aria-label","Wireless");
        wifiBadge.title="Wireless";

        // Transparent Wi-Fi glyph only: no emoji tile/background.
        // Keep it compact and centered immediately above the component image.
        wifiBadge.innerHTML=[
          '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"',
          ' xmlns="http://www.w3.org/2000/svg" fill="none">',
          '<path d="M3.2 8.8C8.1 4.7 15.9 4.7 20.8 8.8"',
          ' stroke="#0756A4" stroke-width="2" stroke-linecap="round"/>',
          '<path d="M6.7 12.2C9.7 9.7 14.3 9.7 17.3 12.2"',
          ' stroke="#0756A4" stroke-width="2" stroke-linecap="round"/>',
          '<path d="M10 15.7C11.2 14.7 12.8 14.7 14 15.7"',
          ' stroke="#0756A4" stroke-width="2" stroke-linecap="round"/>',
          '<circle cx="12" cy="19" r="1.35" fill="#0756A4"/>',
          '</svg>'
        ].join("");
        wifiBadge.style.cssText=[
          "position:absolute",
          "z-index:32",
          "pointer-events:none",
          "user-select:none",
          "transform:translate(-50%,-108%)",
          "width:16px",
          "height:16px",
          "display:flex",
          "align-items:center",
          "justify-content:center",
          "background:transparent",
          "border:none",
          "border-radius:0",
          "padding:0",
          "margin:0",
          "box-shadow:none",
          "filter:none",
          "line-height:1"
        ].join(";");
        positionWifiBadge();
        stage.appendChild(wifiBadge);
      }

      // Component label: render as SVG text on the live Worksheet layer so it
      // remains visible below the component and cannot be clipped by HTML drag
      // targets. The label is non-interactive and follows the component on drag.
      const labelText=String(c.title||c.component||id);
      const [lx,ly,lw,lh]=cloneBox(c.box);
      const labelX=lx+(lw/2);
      const labelY=ly+lh+0.18;

      const labelUnder=routeEl("text",{
        x:labelX,
        y:labelY,
        "text-anchor":"middle",
        "dominant-baseline":"hanging",
        "font-size":"0.16",
        "font-family":"Arial, Segoe UI, sans-serif",
        "font-weight":"700",
        fill:"#ffffff",
        stroke:"#ffffff",
        "stroke-width":"0.055",
        "stroke-linejoin":"round",
        style:"pointer-events:auto;user-select:none;cursor:text;"
      });
      labelUnder.textContent=labelText;
      routeSvg.appendChild(labelUnder);

      const labelMain=routeEl("text",{
        x:labelX,
        y:labelY,
        "text-anchor":"middle",
        "dominant-baseline":"hanging",
        "font-size":"0.16",
        "font-family":"Arial, Segoe UI, sans-serif",
        "font-weight":"700",
        fill:"#173f75",
        style:"pointer-events:auto;user-select:none;cursor:text;"
      });
      labelMain.textContent=labelText;
      routeSvg.appendChild(labelMain);

      componentLabels.set(id,{under:labelUnder,main:labelMain});
      applyComponentLabelVisibility(componentLabels.get(id),c);
      labelMain.addEventListener("click",event=>beginLabelEdit(id,{under:labelUnder,main:labelMain},event));
      labelUnder.addEventListener("click",event=>beginLabelEdit(id,{under:labelUnder,main:labelMain},event));

      const hit=document.createElement("div");
      hit.dataset.componentId=id;
      hit.title=String(c.title||c.component||id);
      hit.style.cssText=`position:absolute;z-index:${hitZ};box-sizing:border-box;cursor:grab;background:rgba(0,0,0,0.001);touch-action:none;pointer-events:auto;-webkit-user-select:none;user-select:none;overflow:visible;`;
      applyBox(hit,c.box);

      if(id===pendingId){
        hit.style.outline="3px solid #0a66e3";
        hit.style.outlineOffset="2px";
        hit.style.borderRadius="6px";
      }

      const add=document.createElement("button");
      add.type="button";
      add.textContent="+";
      add.title="Add another component";
      add.setAttribute("aria-label",`Add another ${String(c.title||c.component||"component")}`);
      add.style.cssText="position:absolute;right:-13px;top:-13px;width:30px;height:30px;border-radius:50%;border:2px solid #fff;background:#0a66e3;color:#fff;font:bold 21px/24px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);z-index:46;opacity:0;pointer-events:none;cursor:pointer;padding:0;";

      const del=document.createElement("button");
      del.type="button";
      del.textContent="×";
      del.title="Delete component";
      del.setAttribute("aria-label",`Delete ${String(c.title||c.component||"component")}`);
      del.style.cssText="position:absolute;left:-13px;top:-13px;width:30px;height:30px;border-radius:50%;border:2px solid #fff;background:#dc2626;color:#fff;font:bold 20px/24px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);z-index:46;opacity:0;pointer-events:none;cursor:pointer;padding:0;";
      layoutComponentActionControls(add,del,c);

      // Clear per-component display selector (Graphic Icon <-> Acronym Box).
      // Placed below the box so it never fights corner resize handles.
      const modeSelect=document.createElement("select");
      modeSelect.title="Display mode for this component";
      modeSelect.innerHTML='<option value="icons">Graphic Icon</option><option value="acronyms">Acronym Box</option>';
      modeSelect.style.cssText=[
        "position:absolute",
        "left:50%",
        "bottom:-30px",
        "transform:translateX(-50%)",
        "min-width:118px",
        "height:24px",
        "border:1px solid #173f75",
        "border-radius:6px",
        "background:#fff",
        "color:#173f75",
        "font:600 11px/22px Segoe UI,Arial,sans-serif",
        "box-shadow:0 2px 8px rgba(15,23,42,.18)",
        "z-index:40",
        "opacity:0",
        "pointer-events:none",
        "cursor:pointer",
        "padding:0 4px"
      ].join(";");
      paintComponentDisplayModeControl(modeSelect,c);

      const applyLocalDisplayMode=(next)=>{
        // Core hosts (Sump / Bore Well / OHT Tank) cannot switch to acronym boxes.
        if(!componentAllowsAcronymDisplay(c))return;
        const mode=String(next||"icons")==="acronyms"?"acronyms":"icons";
        c.display_mode=mode;
        paintComponentDisplayModeControl(modeSelect,c);
        const oldVisual=componentVisuals.get(id);
        let nextVisual;
        const visualZ=c.__oht_attached_sensor?19:(isPrimaryCanvasComponent(c)?15:28);
        if(mode==="acronyms"){
          nextVisual=document.createElement("div");
          nextVisual.className="component-acronym-box";
          nextVisual.textContent=componentAcronymText(c);
          nextVisual.title=String(c.title||c.component||id);
          nextVisual.style.cssText=`position:absolute;z-index:${visualZ};pointer-events:none;user-select:none;`;
          applyVisibleComponentImageBox(nextVisual,c.box);
        }else{
          nextVisual=document.createElement("img");
          nextVisual.draggable=false;
          nextVisual.alt=String(c.title||c.component||id);
          nextVisual.src=`data:image/png;base64,${String(c.image_b64||"").trim()}`;
          nextVisual.style.cssText=`position:absolute;z-index:${visualZ};pointer-events:none;user-select:none;object-fit:${String(c.image_fit||"contain")};`;
          if(c.__oht_attached_sensor)revealInternalSensorGlyph(nextVisual);
          applyVisibleComponentImageBox(nextVisual,c.box);
        }
        if(oldVisual&&oldVisual.parentNode){
          oldVisual.parentNode.replaceChild(nextVisual,oldVisual);
        }else{
          stage.appendChild(nextVisual);
        }
        if(mode==="acronyms"){
          fitAcronymBoxFont(nextVisual,c.box);
        }
        componentVisuals.set(id,nextVisual);
        applyComponentLabelVisibility(componentLabels.get(id),c);
        layoutComponentActionControls(add,del,c);
        const overlayItem=overlays.get(id);
        if(overlayItem){
          overlayItem.visual=nextVisual;
          if(overlayItem.resizeHandles&&overlayItem.resizeHandles.length){
            const showResize=mode==="acronyms";
            for(const handle of overlayItem.resizeHandles){
              handle.style.display=showResize?"":"none";
            }
          }
        }
        // Keep + / delete immediately available after switching into acronym mode.
        showControlsForTwoSeconds(id,{persist:true});
        // Persist presentation mode in the movement draft so a later remount
        // (delete/add of a different component) cannot reset this box to icons.
        saveMovementDraft();
        emit("component_display_mode",{
          instance_id:id,
          display_mode:mode,
          component:String(c.component||"")
        });
      };

      add.addEventListener("pointerdown",e=>{e.preventDefault();e.stopPropagation();});
      del.addEventListener("pointerdown",e=>{e.preventDefault();e.stopPropagation();});
      modeSelect.addEventListener("pointerdown",e=>{e.stopPropagation();});
      add.addEventListener("click",e=>{
        e.preventDefault();e.stopPropagation();
        requestWorksheetComponentAdd(String(c.component||""),id,c);
      });
      del.addEventListener("click",e=>{
        e.preventDefault();e.stopPropagation();
        optimisticWorksheetDelete(id);
        emit("component_delete",{component:String(c.component||""),instance_id:id});
      });
      modeSelect.addEventListener("change",e=>{
        e.preventDefault();
        e.stopPropagation();
        applyLocalDisplayMode(modeSelect.value);
      });
      modeSelect.addEventListener("click",e=>{
        e.stopPropagation();
        showControlsForTwoSeconds(id,{persist:true});
      });

      hit.addEventListener("contextmenu",e=>{
        e.preventDefault();
        e.stopPropagation();
        showControlsForTwoSeconds(id,{persist:true});
        closeContext();
        const menu=document.createElement("div");
        menu.className="context";
        menu.style.left=`${Math.min(e.clientX,window.innerWidth-180)}px`;
        menu.style.top=`${Math.min(e.clientY,window.innerHeight-160)}px`;
        const addAction=(label,fn,danger=false)=>{
          const b=document.createElement("button");
          b.type="button";
          b.textContent=label;
          if(danger)b.className="danger";
          b.addEventListener("click",()=>{
            fn();
            closeContext();
          });
          menu.appendChild(b);
        };
        // Always offer count/delete actions — including while in Acronym Box mode.
        addAction("Add another (+)",()=>{
          requestWorksheetComponentAdd(String(c.component||""),id,c);
        });
        addAction("Delete component",()=>{
          optimisticWorksheetDelete(id);
          emit("component_delete",{component:String(c.component||""),instance_id:id});
        },true);
        if(componentAllowsAcronymDisplay(c)){
          const addMode=(label,mode)=>{
            const b=document.createElement("button");
            b.type="button";
            b.textContent=label;
            if(componentDisplayMode(c)===mode)b.style.fontWeight="700";
            b.addEventListener("click",()=>{
              applyLocalDisplayMode(mode);
              closeContext();
            });
            menu.appendChild(b);
          };
          addMode("Graphic Icon","icons");
          addMode("Acronym Box","acronyms");
        }
        document.body.appendChild(menu);
        contextMenu=menu;
      });
      hit.addEventListener("pointerenter",()=>{
        showControlsForTwoSeconds(id);
      });
      hit.addEventListener("pointerleave",()=>{
        // Intentionally do not hide/cancel here. The controls must remain visible
        // for the full 2 seconds from the original hover/touch moment.
      });

      const detachActiveDragWindowListeners=()=>{
        clearLiveComponentDragWindowListeners();
        if(activeDrag)activeDrag.windowListeners=null;
      };

      hit.addEventListener("pointerdown",e=>{
        if(e.button!==0&&e.pointerType!=="touch"&&e.pointerType!=="pen")return;
        if(e.target===add||e.target===del||e.target===modeSelect||(e.target&&e.target.dataset&&e.target.dataset.acronymResize))return;
        if(liveComponentDrag&&liveComponentDrag.active)return;

        if(e.pointerType==="touch"||e.pointerType==="pen"){
          showControlsForTwoSeconds(id,{persist:true});
        }

        e.preventDefault();
        e.stopPropagation();

        // Register grab origin from this exact pointerdown. Prefer a real stage
        // CTM/rect; if layout is not ready yet, re-baseline on the first move.
        const startClient=[Number(e.clientX)||0,Number(e.clientY)||0];
        const start=canvasPointFromClient(startClient[0],startClient[1]);
        const attachedRoutes=connectedRoutes(id);
        const attachedComponents=Object.values(components)
          .filter(child=>
            child &&
            !child.hidden &&
            child.__oht_attached_sensor &&
            String(child.__oht_parent_id||"")===id
          )
          .map(child=>{
            const childId=String(child.instance_id||"");
            const childRoutes=connectedRoutes(childId);
            return {
              id:childId,
              component:child,
              base:cloneBox(child.box),
              routes:childRoutes,
              routeBase:Object.fromEntries(
                childRoutes.map(route=>[
                  String(route.edge_id||""),
                  clonePoints(route.points)
                ])
              ),
              routePortRefs:Object.fromEntries(
                childRoutes.map(route=>{
                  const edgeId=String(route.edge_id||"");
                  const pts=Array.isArray(route.points)?route.points:[];
                  return [edgeId,{
                    source:String(route.source||"")===childId&&pts.length
                      ?inferPortReference(child.box,pts[0])
                      :null,
                    target:String(route.target||"")===childId&&pts.length
                      ?inferPortReference(child.box,pts[pts.length-1])
                      :null
                  }];
                })
              )
            };
          });
        activeDrag={
          id,
          component:c,
          pointerId:e.pointerId,
          start:start||[0,0],
          startClient,
          startReady:!!start,
          base:cloneBox(c.box),
          attachedRoutes,
          attachedComponents,

          // Keep the exact current route geometry as the immutable drag baseline.
          // Connected line endpoints are translated from this baseline while the
          // component moves; all unrelated route geometry remains untouched.
          routeBase:Object.fromEntries(
            attachedRoutes.map(route=>[
              String(route.edge_id||""),
              clonePoints(route.points)
            ])
          ),

          // Referential port lock: remember the exact port side/position used by
          // each connected route at drag start. The same reference is resolved
          // against the component's live box throughout the drag.
          routePortRefs:Object.fromEntries(
            attachedRoutes.map(route=>{
              const edgeId=String(route.edge_id||"");
              const pts=Array.isArray(route.points)?route.points:[];
              return [edgeId,{
                source:String(route.source||"")===id&&pts.length
                  ?inferPortReference(c.box,pts[0])
                  :null,
                target:String(route.target||"")===id&&pts.length
                  ?inferPortReference(c.box,pts[pts.length-1])
                  :null
              }];
            })
          ),

          moved:false,
          ghost:makeGhostFromPreview(c),
          windowListeners:null
        };
        liveComponentDrag={active:true,id,pointerId:e.pointerId};
        stage.appendChild(activeDrag.ghost);
        hit.style.cursor="grabbing";
        hit.style.outline="2px dashed #0a66e3";
        hit.style.outlineOffset="2px";
        try{hit.setPointerCapture(e.pointerId);}catch(_){}

        const onWindowMove=ev=>{
          if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==ev.pointerId)return;
          scheduleActiveDragMove(ev);
        };
        const onWindowUp=ev=>{
          if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==ev.pointerId)return;
          finish(ev);
        };
        const onWindowCancel=ev=>{
          if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==ev.pointerId)return;
          // A cancelled gesture that already translated must keep the live box
          // (same as pointerup). Resetting to base caused the first-drag jump.
          if(activeDrag.moved)finish(ev);
          else cancelActiveDrag(ev);
        };
        clearLiveComponentDragWindowListeners();
        activeDrag.windowListeners=[
          ["pointermove",onWindowMove],
          ["pointerup",onWindowUp],
          ["pointercancel",onWindowCancel]
        ];
        liveComponentDragWindowListeners=activeDrag.windowListeners.slice();
        for(const [type,listener] of liveComponentDragWindowListeners){
          window.addEventListener(type,listener);
        }
      });

      const moveActiveDrag=e=>{
        if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==e.pointerId)return;
        if(typeof e.preventDefault==="function"){
          e.preventDefault();
          e.stopPropagation();
        }

        let p=canvasPointFromClient(e.clientX,e.clientY);
        if(!p)return;
        // First usable layout rect: lock startX/startY from the original
        // pointerdown client coordinates so delta math never uses [0,0].
        if(!activeDrag.startReady){
          const rebased=canvasPointFromClient(
            activeDrag.startClient[0],
            activeDrag.startClient[1]
          );
          activeDrag.start=rebased||p;
          activeDrag.startReady=true;
        }
        const [bx,by,bw,bh]=activeDrag.base;
        const dx=p[0]-activeDrag.start[0];
        const dy=p[1]-activeDrag.start[1];
        const proposedBox=[
          clamp(bx+dx,0,Math.max(0,cw-bw)),
          clamp(by+dy,0,Math.max(0,ch-bh)),
          bw,
          bh
        ];
        const snappedBox=snapBoxToConnectedRoute(activeDrag,proposedBox,stage,cw,ch);
        // Suppress snap that rubber-bands the card back toward its grab origin.
        const away=Math.hypot(proposedBox[0]-bx,proposedBox[1]-by);
        const snapAway=Math.hypot(snappedBox[0]-bx,snappedBox[1]-by);
        const useFree=away>0.03&&snapAway<away*0.45;
        const nx=useFree?proposedBox[0]:snappedBox[0];
        const ny=useFree?proposedBox[1]:snappedBox[1];

        c.box=[nx,ny,bw,bh];
        applyBox(hit,c.box);
        applyVisibleComponentImageBox(visual,c.box);
        positionWifiBadge();

        const labelPair=componentLabels.get(id);
        if(labelPair){
          const labelX=nx+(bw/2);
          const labelY=ny+bh+0.18;
          labelPair.under.setAttribute("x",String(labelX));
          labelPair.under.setAttribute("y",String(labelY));
          labelPair.main.setAttribute("x",String(labelX));
          labelPair.main.setAttribute("y",String(labelY));
        }

        applyVisibleComponentImageBox(activeDrag.ghost,c.box);

        // OHT-only attachment: move its sensor by the same drag delta. Only the
        // sensor's already-connected terminal route endpoint follows it.
        for(const childState of (activeDrag.attachedComponents||[])){
          const child=childState.component;
          const [cbx,cby,cbw,cbh]=childState.base;
          child.box=[cbx+(nx-bx),cby+(ny-by),cbw,cbh];

          const childVisual=componentVisuals.get(childState.id);
          if(childVisual)applyVisibleComponentImageBox(childVisual,child.box);

          for(const route of (childState.routes||[])){
            const edgeId=String(route.edge_id||"");
            const basePoints=childState.routeBase?.[edgeId];
            if(!Array.isArray(basePoints)||basePoints.length<2)continue;

            route.points=clonePoints(basePoints);
            const sensorPoint=sensorAnchorPoint(child.box);
            if(String(route.source||"")===childState.id){
                route.points=moveConnectedRouteEndpointToPort(
                route.points,true,sensorPoint
                );
            }
            if(String(route.target||"")===childState.id){
                route.points=moveConnectedRouteEndpointToPort(
                route.points,false,sensorPoint
                );
            }

            route.points=cleanDraggedRoutePoints(route.points);
            refreshArrowAngleFromCurrentGeometry(route);
            updateRouteVisual(edgeId);
          }
        }

        // Move ONLY the line geometry attached to this component.
        // Always rebuild from the drag-start baseline so repeated pointermove
        // events cannot accumulate drift or alter any unrelated bend/segment.
        for(const route of (activeDrag.attachedRoutes||[])){
          const edgeId=String(route.edge_id||"");
          const basePoints=activeDrag.routeBase?.[edgeId];
          if(!Array.isArray(basePoints)||basePoints.length<2)continue;

          route.points=clonePoints(basePoints);
          const portRefs=activeDrag.routePortRefs?.[edgeId]||{};
          const otherId=String(route.source||"")===id
            ?String(route.target||"")
            :String(route.source||"");
          const sensorPoint=c.__oht_attached_sensor?sensorAnchorPoint(c.box):null;

          if(String(route.source||"")===id){
            const sourcePort=sensorPoint||resolvePortReference(c.box,portRefs.source);
            if(sourcePort){
              route.points=moveConnectedRouteEndpointToPort(
                route.points,true,sourcePort
              );
            }
          }

          if(String(route.target||"")===id){
            const targetPort=sensorPoint||resolvePortReference(c.box,portRefs.target);
            if(targetPort){
              route.points=moveConnectedRouteEndpointToPort(
                route.points,false,targetPort
              );
            }
          }

          const linkedSensor=(activeDrag.attachedComponents||[]).find(
            childState=>String(childState.id||"")===otherId
          );
          if(linkedSensor&&linkedSensor.component){
            route.points=moveConnectedRouteEndpointToPort(
              route.points,
              String(route.source||"")===otherId,
              sensorAnchorPoint(linkedSensor.component.box)
            );
          }

          // Maintain a clean right-angle route while the component moves.
          route.points=cleanDraggedRoutePoints(route.points);
          refreshArrowAngleFromCurrentGeometry(route);

          // Update the already-existing SVG nodes in place for a live drag.
          updateRouteVisual(edgeId);
        }

        activeDrag.moved=activeDrag.moved||Math.hypot(nx-bx,ny-by)>.02;
      };

      // Snapshot clientX/Y per frame (same helper as route dragging). Holding the
      // live PointerEvent across rAF can lose coordinates on the first gesture.
      const dragPointerQueue=createRafPointerQueue(eventLike=>{
        if(!activeDrag||activeDrag.id!==id)return;
        moveActiveDrag(eventLike);
      });
      const scheduleActiveDragMove=e=>{
        if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==e.pointerId)return;
        if(typeof e.preventDefault==="function"){
          e.preventDefault();
          e.stopPropagation();
        }
        dragPointerQueue.push(e);
      };
      const flushActiveDragMove=e=>{
        dragPointerQueue.flush(e||null);
      };

      hit.addEventListener("pointermove",scheduleActiveDragMove);
      stage.addEventListener("pointermove",scheduleActiveDragMove);

      const cancelActiveDrag=e=>{
        if(!activeDrag||activeDrag.id!==id)return;
        if(e&&activeDrag.pointerId!==e.pointerId)return;
        dragPointerQueue.cancel();
        const d=activeDrag;
        detachActiveDragWindowListeners();
        activeDrag=null;
        liveComponentDrag=null;
        try{if(e)hit.releasePointerCapture(e.pointerId);}catch(_){}

        c.box=cloneBox(d.base);
        applyBox(hit,c.box);
        applyVisibleComponentImageBox(visual,c.box);
        positionWifiBadge();

        for(const childState of (d.attachedComponents||[])){
          childState.component.box=cloneBox(childState.base);
          const childVisual=componentVisuals.get(childState.id);
          if(childVisual){
            applyVisibleComponentImageBox(childVisual,childState.component.box);
          }
          for(const [edgeId,points] of Object.entries(childState.routeBase||{})){
            if(!routes[edgeId])continue;
            routes[edgeId].points=clonePoints(points);
            updateRouteVisual(edgeId);
          }
        }

        for(const [edgeId,points] of Object.entries(d.routeBase||{})){
          if(!routes[edgeId])continue;
          routes[edgeId].points=clonePoints(points);
          updateRouteVisual(edgeId);
        }

        const labelPair=componentLabels.get(id);
        if(labelPair){
          const [rx,ry,rw,rh]=cloneBox(c.box);
          const labelX=rx+(rw/2);
          const labelY=ry+rh+0.18;
          labelPair.under.setAttribute("x",String(labelX));
          labelPair.under.setAttribute("y",String(labelY));
          labelPair.main.setAttribute("x",String(labelX));
          labelPair.main.setAttribute("y",String(labelY));
        }

        if(d.ghost&&d.ghost.parentNode)d.ghost.parentNode.removeChild(d.ghost);
        hit.style.cursor="grab";
        hit.style.outline=id===pendingId?"3px solid #0a66e3":"none";
        hit.style.outlineOffset=id===pendingId?"2px":"0";
      };

      const finish=e=>{
        if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==e.pointerId)return;
        flushActiveDragMove(e);
        if(typeof e.preventDefault==="function"){
          e.preventDefault();
          e.stopPropagation();
        }

        const d=activeDrag;
        detachActiveDragWindowListeners();
        activeDrag=null;
        liveComponentDrag=null;
        try{hit.releasePointerCapture(e.pointerId);}catch(_){}
        if(d.ghost&&d.ghost.parentNode)d.ghost.parentNode.removeChild(d.ghost);
        hit.style.cursor="grab";
        hit.style.outline=id===pendingId?"3px solid #0a66e3":"none";
        hit.style.outlineOffset=id===pendingId?"2px":"0";

        if(d.moved){
          c.__user_dragged=true;
          for(const childState of (d.attachedComponents||[])){
            if(childState.component)childState.component.__user_dragged=true;
          }
          saveMovementDraft();
          suppressComponentClick=true;
          const movedComponents=[{
            instance_id:id,
            component:String(c.component||""),
            box:cloneBox(c.box)
          }];
          for(const childState of (d.attachedComponents||[])){
            const child=childState.component;
            const childId=String(child&&child.instance_id||"");
            if(!childId||!child.box)continue;
            movedComponents.push({
              instance_id:childId,
              component:String(child.component||""),
              box:cloneBox(child.box)
            });
          }
          const movedRoutesById=new Map();
          for(const route of [
            ...(d.attachedRoutes||[]),
            ...(d.attachedComponents||[]).flatMap(
              childState=>childState.routes||[]
            )
          ]){
            const edgeId=String(route&&route.edge_id||"");
            if(!edgeId||!Array.isArray(route.points)||route.points.length<2)continue;
            movedRoutesById.set(edgeId,{
              edge_id:edgeId,
              source:String(route.source||""),
              target:String(route.target||""),
              points:clonePoints(route.points)
            });
          }
          // Emit after the drag lock clears so the Streamlit remount cannot
          // interrupt the just-finished first grab.
          const movePayload={
            instance_id:id,
            component:String(c.component||""),
            box:cloneBox(c.box),
            moved_components:movedComponents,
            moved_routes:[...movedRoutesById.values()]
          };
          setTimeout(()=>emit("component_move",movePayload),0);
        }else if(String(c.component||"")==="Transmitter"){
          // pointerdown preventDefault can drop the click on the first
          // Transmitter press. Emit that selection here and ignore the click
          // that would otherwise cancel it.
          suppressComponentClick=true;
          emit("component_select",{
            instance_id:id,
            component:"Transmitter"
          });
        }else{
          // Selection is emitted by the normal click event below.
        }
      };

      hit.addEventListener("pointerup",finish);
      stage.addEventListener("pointerup",finish);
      hit.addEventListener("click",e=>{
        if(suppressComponentClick){suppressComponentClick=false;return;}
        e.preventDefault();
        e.stopPropagation();
        if(manualDraw.handleComponent(id))return;
        emit("component_select",{
          instance_id:id,
          component:String(c.component||"")
        });
      });
      hit.addEventListener("pointercancel",e=>{
        if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==e.pointerId)return;
        if(activeDrag.moved)finish(e);
        else cancelActiveDrag(e);
      });

      const resizeHandles=[];
      if(componentDisplayMode(c)==="acronyms"){
        const cornerStyle={
          nw:["left:-6px","top:-6px","cursor:nwse-resize"],
          ne:["right:-6px","top:-6px","cursor:nesw-resize"],
          sw:["left:-6px","bottom:-6px","cursor:nesw-resize"],
          se:["right:-6px","bottom:-6px","cursor:nwse-resize"]
        };
        for(const corner of ["nw","ne","sw","se"]){
          const handle=document.createElement("div");
          handle.dataset.acronymResize=corner;
          handle.title="Resize acronym box";
          handle.style.cssText=[
            "position:absolute",
            ...cornerStyle[corner],
            "width:14px",
            "height:14px",
            "border-radius:3px",
            "border:2px solid #2563eb",
            "background:#fff",
            "box-shadow:0 1px 4px rgba(15,23,42,.25)",
            "z-index:32",
            "opacity:0",
            "pointer-events:none",
            "touch-action:none"
          ].join(";");
          let resizeSession=null;
          const stopResize=ev=>{
            if(!resizeSession||resizeSession.pointerId!==ev.pointerId)return;
            if(typeof ev.preventDefault==="function"){
              ev.preventDefault();
              ev.stopPropagation();
            }
            const session=resizeSession;
            resizeSession=null;
            try{handle.releasePointerCapture(ev.pointerId);}catch(_){}
            window.removeEventListener("pointermove",onResizeMove,true);
            window.removeEventListener("pointerup",stopResize,true);
            window.removeEventListener("pointercancel",stopResize,true);
            if(!session.moved)return;
            c.__user_dragged=true;
            saveMovementDraft();
            suppressComponentClick=true;
            setTimeout(()=>emit("component_move",{
              instance_id:id,
              component:String(c.component||""),
              box:cloneBox(c.box),
              moved_components:[{
                instance_id:id,
                component:String(c.component||""),
                box:cloneBox(c.box)
              }]
            }),0);
          };
          const onResizeMove=ev=>{
            if(!resizeSession||resizeSession.pointerId!==ev.pointerId)return;
            const point=canvasPoint(ev);
            if(!point)return;
            const dx=point[0]-resizeSession.start[0];
            const dy=point[1]-resizeSession.start[1];
            if(Math.abs(dx)>0.01||Math.abs(dy)>0.01)resizeSession.moved=true;
            c.box=resizeAcronymBox(resizeSession.box,corner,dx,dy);
            applyBox(hit,c.box);
            applyVisibleComponentImageBox(visual,c.box);
            const labelPair=componentLabels.get(id);
            if(labelPair){
              const [rx,ry,rw,rh]=cloneBox(c.box);
              const labelX=rx+(rw/2);
              const labelY=ry+rh+0.18;
              labelPair.under.setAttribute("x",String(labelX));
              labelPair.under.setAttribute("y",String(labelY));
              labelPair.main.setAttribute("x",String(labelX));
              labelPair.main.setAttribute("y",String(labelY));
            }
            if(wifiBadge)positionWifiBadge();
          };
          handle.addEventListener("pointerdown",ev=>{
            if(ev.button!==0&&ev.pointerType!=="touch"&&ev.pointerType!=="pen")return;
            ev.preventDefault();
            ev.stopPropagation();
            showControlsForTwoSeconds(id,{persist:true});
            resizeSession={
              pointerId:ev.pointerId,
              start:canvasPoint(ev),
              box:cloneBox(c.box),
              moved:false
            };
            try{handle.setPointerCapture(ev.pointerId);}catch(_){}
            window.addEventListener("pointermove",onResizeMove,true);
            window.addEventListener("pointerup",stopResize,true);
            window.addEventListener("pointercancel",stopResize,true);
          });
          hit.appendChild(handle);
          resizeHandles.push(handle);
        }
      }

      // Append actions after resize grips so + / delete paint above them.
      hit.appendChild(add);
      hit.appendChild(del);
      // Acronym toggle/resize UI is secondary-components only.
      if(componentAllowsAcronymDisplay(c)){
        hit.appendChild(modeSelect);
      }
      layoutComponentActionControls(add,del,c);
      stage.appendChild(hit);
      overlays.set(id,{
        hit,
        add,
        del,
        modeSelect:componentAllowsAcronymDisplay(c)?modeSelect:null,
        resizeHandles,
        visual
      });
    }

    for(const c of Object.values(components)){
      if(!c||c.hidden||!c.__oht_attached_sensor)continue;
      const sensorVisual=componentVisuals.get(String(c.instance_id||""));
      if(sensorVisual)stage.appendChild(sensorVisual);
    }

    const componentIdAtPointer=(ev)=>{
      const p=canvasPoint(ev);
      const list=Object.values(components).filter(
        c=>c&&!c.hidden&&!c.__oht_attached_sensor
      ).reverse();
      for(const c of list){
        const id=String(c.instance_id||"");
        const b=cloneBox(c.box);
        if(
          p[0]>=b[0] && p[0]<=b[0]+b[2] &&
          p[1]>=b[1] && p[1]<=b[1]+b[3]
        ){
          return id;
        }
      }
      return "";
    };

    // Detect hover from the whole Worksheet stage as well as each component hit
    // target. This keeps the timing reliable even where an existing arrow/route
    // interaction layer overlaps the component image.
    let stageHoverComponentId="";
    stage.addEventListener("pointermove",e=>{
      if(activeDrag||activeRouteDrag)return;
      if(e.pointerType && e.pointerType!=="mouse" && e.pointerType!=="pen")return;

      const id=componentIdAtPointer(e);
      if(id && id!==stageHoverComponentId){
        stageHoverComponentId=id;
        showControlsForTwoSeconds(id);
      }else if(!id){
        // Leaving the image only resets entry tracking. It does NOT hide or
        // cancel the currently visible controls; their own 2-second timer does that.
        stageHoverComponentId="";
      }
    });

    stage.addEventListener("pointerleave",()=>{
      // Keep any visible Add/Delete controls alive until their 2-second timers end.
      stageHoverComponentId="";
    });

    restorePersistedHoverReveals();

    bg.addEventListener("load",()=>{
      if(argsState.fit_screen){
        if(hasFixedHeight){
          lastHeight=fixedScreenHeight;
          post(SET_HEIGHT,{height:fixedScreenHeight});
        }
      }else{
        requestAnimationFrame(()=>setHeight(true));
      }
    });

    if(argsState.fit_screen){
      if(hasFixedHeight){
        lastHeight=fixedScreenHeight;
        post(SET_HEIGHT,{height:fixedScreenHeight});
      }
    }else{
      requestAnimationFrame(()=>setHeight(true));
    }
    refreshWorksheetAnnotations=()=>mountWorksheetAnnotations(stage,cw,ch,canvasPoint,addDragOnlyWindowListener);
    refreshWorksheetAnnotations();
  }

  function renderNormal(){
    root.innerHTML="";
    root.style.position="relative";
    const pendingId=String(argsState.pending_connection_source_id||"");
    const hotspotElements=new Map();

    const img=document.createElement("img");
    img.style.cssText="display:block;width:100%;height:auto";
    img.src=`data:image/png;base64,${argsState.image_b64||""}`;
    root.appendChild(img);

    const overlay=document.createElementNS("http://www.w3.org/2000/svg","svg");
    overlay.setAttribute("viewBox",`0 0 ${Number(argsState.canvas_width||1)} ${Number(argsState.canvas_height||1)}`);
    overlay.setAttribute("preserveAspectRatio","xMidYMid meet");
    overlay.style.cssText="position:absolute;inset:0;width:100%;height:100%;z-index:18;pointer-events:none;overflow:visible;";
    root.appendChild(overlay);

    img.addEventListener("load",()=>setHeight(true));

    const refreshSelection=()=>{
      for(const [id,el] of hotspotElements.entries()){
        if(id===pendingId){
          el.style.outline="3px solid #0a66e3";
          el.style.outlineOffset="2px";
          el.style.borderRadius="6px";
        }else{
          el.style.outline="none";
          el.style.outlineOffset="0";
        }
      }
    };

    const itemById=(id)=>(argsState.hotspots||[]).find(x=>String(x.instance_id||"")===String(id||""));
    const centerOf=(item)=>[
      Number(item.left||0)+Number(item.width||0)/2,
      Number(item.top||0)+Number(item.height||0)/2
    ];
    const drawImmediateConnection=(firstId,secondId)=>{
      const first=itemById(firstId), second=itemById(secondId);
      if(!first||!second)return;
      const [x1,y1]=centerOf(first), [x2,y2]=centerOf(second);
      const line=document.createElementNS("http://www.w3.org/2000/svg","polyline");
      const mx=(x1+x2)/2;
      line.setAttribute("points",`${x1},${y1} ${mx},${y1} ${mx},${y2} ${x2},${y2}`);
      line.setAttribute("fill","none");
      line.setAttribute("stroke","#123DBD");
      line.setAttribute("stroke-width","0.015");
      line.setAttribute("stroke-linecap","round");
      line.setAttribute("stroke-linejoin","round");
      line.setAttribute("vector-effect","non-scaling-stroke");
      overlay.appendChild(line);
    };

    const chooseComponent=(item,itemId)=>{
      if(!itemId)return;
      if(pendingId && pendingId!==itemId){
        drawImmediateConnection(pendingId,itemId);
      }
      emit("component_select",{instance_id:itemId,component:String(item.component||"")});
    };

    for(const item of (argsState.hotspots||[])){
      const hover=document.createElement("div");
      const itemId=String(item.instance_id||"");
      hover.style.cssText=`position:absolute;z-index:19;background:transparent;cursor:pointer;touch-action:manipulation;left:${100*Number(item.left||0)/Number(argsState.canvas_width||1)}%;top:${100*Number(item.top||0)/Number(argsState.canvas_height||1)}%;width:${100*Number(item.width||0)/Number(argsState.canvas_width||1)}%;height:${100*Number(item.height||0)/Number(argsState.canvas_height||1)}%;`;
      hotspotElements.set(itemId,hover);

      const b=document.createElement("button");
      b.type="button";
      b.title="Add another component";
      b.setAttribute("aria-label",`Add another ${String(item.title||item.component||"component")}`);
      b.textContent="+";
      b.style.cssText="position:absolute;z-index:20;opacity:0;pointer-events:none;display:flex;align-items:center;justify-content:center;border:2px solid #fff;border-radius:50%;background:#0a66e3;color:#fff;font:bold 20px/1 Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;transition:opacity .12s ease;right:-8px;top:-8px;width:30px;height:30px;";

      const d=document.createElement("button");
      d.type="button";
      d.title="Delete this component";
      d.setAttribute("aria-label",`Delete ${String(item.title||item.component||"component")}`);
      d.textContent="×";
      d.style.cssText="position:absolute;z-index:20;opacity:0;pointer-events:none;display:flex;align-items:center;justify-content:center;border:2px solid #fff;border-radius:50%;background:#dc2626;color:#fff;font:bold 19px/1 Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;transition:opacity .12s ease;left:-8px;top:-8px;width:30px;height:30px;";

      let hoverRevealTimer=null;
      const show=()=>{
        b.style.opacity="1";
        b.style.pointerEvents="auto";
        d.style.opacity="1";
        d.style.pointerEvents="auto";
      };
      const hideNow=()=>{
        b.style.opacity="0";
        b.style.pointerEvents="none";
        d.style.opacity="0";
        d.style.pointerEvents="none";
      };
      const showForTwoSeconds=()=>{
        if(hoverRevealTimer!==null)clearTimeout(hoverRevealTimer);
        show();
        hoverRevealTimer=setTimeout(()=>{
          hoverRevealTimer=null;
          hideNow();
        },2000);
      };
      hover.addEventListener("mouseenter",showForTwoSeconds);
      hover.addEventListener("mouseleave",()=>{
        // Do not hide on leave. The 2-second timer continues to completion.
      });
      hover.addEventListener("focusin",showForTwoSeconds);
      hover.addEventListener("focusout",()=>{
        // Same fixed 2-second behavior for focus/touch-capable devices.
      });
      hover.addEventListener("pointerenter",showForTwoSeconds);
      hover.addEventListener("pointerdown",e=>{
        if(e.target===b||e.target===d)return;
        if(e.pointerType==="touch"||e.pointerType==="pen"){
          showForTwoSeconds();
        }
      });

      let lastPointerSelection=0;
      hover.addEventListener("pointerup",e=>{
        if(e.target===b||e.target===d)return;
        if(e.pointerType!=="touch"&&e.pointerType!=="pen")return;
        e.preventDefault();
        e.stopPropagation();
        lastPointerSelection=Date.now();
        chooseComponent(item,itemId);
      });
      hover.addEventListener("click",e=>{
        if(e.target===b||e.target===d)return;
        if(Date.now()-lastPointerSelection<500)return;
        e.preventDefault();
        e.stopPropagation();
        chooseComponent(item,itemId);
      });
      b.addEventListener("click",e=>{
        e.preventDefault();
        e.stopPropagation();
        requestWorksheetComponentAdd(String(item.component||""),itemId,item);
      });
      d.addEventListener("click",e=>{
        e.preventDefault();
        e.stopPropagation();
        optimisticWorksheetDelete(itemId);
        emit("component_delete",{component:String(item.component||""),instance_id:itemId});
      });
      hover.appendChild(b);
      hover.appendChild(d);
      root.appendChild(hover);
    }
    refreshSelection();
    setHeight(true);
  }

  function consumeAutoRouteToken(incoming){
    const token=String((incoming&&incoming.auto_route_token)||"");
    if(!token||token===appliedAutoRouteToken)return;
    appliedAutoRouteToken=token;
    const draftKey=String((incoming&&incoming.local_draft_key)||argsState.local_draft_key||"").trim();
    if(!draftKey)return;
    try{
      const saved=JSON.parse(sessionStorage.getItem(`rts:${draftKey}`)||"null");
      if(!saved||typeof saved!=="object")return;
      saved.routes=[];
      sessionStorage.setItem(`rts:${draftKey}`,JSON.stringify(saved));
    }catch(_){}
  }

  function clearLiveComponentDragWindowListeners(){
    for(const [type,listener] of liveComponentDragWindowListeners){
      window.removeEventListener(type,listener);
    }
    liveComponentDragWindowListeners=[];
  }

  function render(args){
    const incoming=args||{};
    consumeAutoRouteToken(incoming);
    worksheetTools.setManualDraw(!!incoming.manual_draw);
    const revision=String(incoming.render_revision||"");
    const compact=!!incoming.compact_payload;

    // An in-flight component grab owns the stage. Accept payload metadata but
    // never wipe DOM / rebind listeners mid-drag (that caused first-try stutter).
    if(liveComponentDrag&&liveComponentDrag.active){
      if(compact){
        argsState={...argsState,...incoming,
          image_b64:argsState.image_b64||"",
          routes:argsState.routes||[],
          hotspots:argsState.hotspots||[],
          components:argsState.components||[]
        };
      }else{
        argsState={...argsState,...incoming,
          image_b64:incoming.image_b64||argsState.image_b64||"",
          routes:argsState.routes||incoming.routes||[],
          hotspots:argsState.hotspots||incoming.hotspots||[],
          components:argsState.components||incoming.components||[]
        };
        if(revision)lastRenderRevision=revision;
      }
      return;
    }

    // Streamlit reruns can resend this component dozens of times while the
    // Worksheet visual state itself has not changed. In compact mode Python
    // intentionally omits the large background PNG, component sprites and
    // route arrays. Preserve the already-mounted heavy payload instead of
    // replacing it with the compact placeholders.
    if(revision&&revision===lastRenderRevision&&compact){
      const notesChanged=JSON.stringify(argsState.annotations||[])!==JSON.stringify(incoming.annotations||[]);
      argsState={...argsState,...incoming,
        image_b64:argsState.image_b64||"",
        routes:argsState.routes||[],
        hotspots:argsState.hotspots||[],
        components:argsState.components||[]
      };
      if(notesChanged&&refreshWorksheetAnnotations)refreshWorksheetAnnotations();
      if(applyAnnotationFormatColor)applyAnnotationFormatColor();
      return;
    }

    // If the iframe was recreated, its in-memory payload is gone even though
    // Python may still think this revision was already sent. Ask Python for one
    // full refresh, then normal compact reruns can resume.
    if(compact){
      emit("request_full_render",{revision});
      return;
    }

    if(revision&&revision===lastRenderRevision){
      const notesChanged=JSON.stringify(argsState.annotations||[])!==JSON.stringify(incoming.annotations||[]);
      argsState=incoming;
      if(notesChanged&&refreshWorksheetAnnotations)refreshWorksheetAnnotations();
      if(applyAnnotationFormatColor)applyAnnotationFormatColor();
      return;
    }
    argsState=incoming;
    lastRenderRevision=revision;
    // Preserve already-mounted edges across rerenders so a new draw/add never
    // replaces the whole collection. Explicit edge delete is the only remover.
    // Saved-project freeze: do NOT merge prior-session routes — payload only.
    const preservedRoutes={};
    if(!argsState.freeze_saved_geometry){
      Object.entries(routes||{}).forEach(([id,route])=>{
        if(!id||!route||route.hidden)return;
        preservedRoutes[id]={
          ...route,
          points:clonePoints(route.points),
          original_points:clonePoints(route.original_points||route.points)
        };
      });
    }
    routes={};components={};selectedEdge=null;selectedComponents.clear();drag=null;zoom=1;panX=0;panY=0;
    const saved=(argsState.edit_mode&&argsState.editor_state&&Array.isArray(argsState.editor_state.routes)&&Array.isArray(argsState.editor_state.components))?argsState.editor_state:null;
    if(saved&&saved.viewport&&typeof saved.viewport==="object"){
      const savedZoom=Number(saved.viewport.zoom);
      const savedPanX=Number(saved.viewport.pan_x);
      const savedPanY=Number(saved.viewport.pan_y);
      if(Number.isFinite(savedZoom))zoom=clamp(savedZoom,.35,4);
      if(Number.isFinite(savedPanX))panX=savedPanX;
      if(Number.isFinite(savedPanY))panY=savedPanY;
    }
    const rr=saved?saved.routes:(argsState.routes||[]),cc=saved?saved.components:(argsState.components||[]);
    rr.forEach(r=>{
      const id=String(r.edge_id||r.id||"");
      if(!id)return;
      if(connectionPairIsDeleted(r.source,r.target))return;
      const source=String(r.source||"");
      const target=String(r.target||"");
      const sourceHandle=String(r.sourceHandle||r.source_handle||(source?`${source}:auto`:""));
      const targetHandle=String(r.targetHandle||r.target_handle||(target?`${target}:auto`:""));
      const next={
        ...r,
        edge_id:id,
        id,
        source,
        target,
        sourceHandle,
        targetHandle,
        source_handle:sourceHandle,
        target_handle:targetHandle,
        points:clonePoints(r.points),
        original_points:clonePoints(r.original_points||r.points),
        hidden:!!r.hidden
      };
      routes[id]=next;
    });
    // Pure additive merge: keep any prior edge the new payload omitted.
    // Skipped for Saved freeze so session/topology edges cannot reappear.
    if(!argsState.freeze_saved_geometry){
      Object.entries(preservedRoutes).forEach(([id,route])=>{
        if(!id||routes[id])return;
        if(connectionPairIsDeleted(route.source,route.target))return;
        routes[id]=route;
      });
    }
    cc.forEach(c=>{const id=String(c.instance_id||"");if(id)components[id]={...c,instance_id:id,box:cloneBox(c.box),hidden:!!c.hidden};});
    Object.values(routes).forEach(route=>{
      if(!routePairIsWater(route))return;
      route.dotted=false;
      route.color="#123DBD";
      route.sketch_lock=true;
    });
    rebuildRouteConnectionIndex();
    if(argsState.drag_only){
      seedInternalSensorTransmitterLines();
      rebuildRouteConnectionIndex();
      // Saved-project freeze: server payload is the source of truth. Do not
      // restore a stale browser draft or regenerate saved component/route geometry.
      if(argsState.freeze_saved_geometry){
        try{
          const key=movementDraftStorageKey();
          if(key)sessionStorage.removeItem(key);
        }catch(_){}
      }else{
        restoreMovementDraft();
        seatInlinePipeSymbols();
        prepareOhtTankSensorAttachments();
        applyClickedOhtSensorEmbeds();
        separateComponentsFromTanks();
        seatInlineDevicesOnOhtDrops();
        forceDottedOhtTransmitterOntoSensor();
        hideEmbeddedOhtSensorRoutes();
        forceUnifiedFluidHeader();
        forceBoreSumpReturn();
        purgeUnsolicitedDottedRoutes();
      }
    }
    if(argsState.edit_mode){initialSnapshot=snapshot();history=[JSON.parse(JSON.stringify(initialSnapshot))];historyIndex=0;dirty=false;renderEditor();}
    else if(argsState.drag_only){renderDragOnly();}
    else renderNormal();
  }
  function keydown(e){const active=document.activeElement;if(["INPUT","TEXTAREA","SELECT"].includes(active?.tagName))return;if(e.target?.closest?.("[data-annotation-field],[data-annotation-title]")||active?.closest?.("[data-annotation-field],[data-annotation-title]"))return;const cmd=e.ctrlKey||e.metaKey,k=String(e.key||"").toLowerCase();if(cmd&&k==="z"){e.preventDefault();e.shiftKey?redoLocal():undoLocal();return;}if(cmd&&k==="y"){e.preventDefault();redoLocal();return;}if(cmd&&k==="c"){e.preventDefault();copySelection();return;}if(cmd&&k==="v"){e.preventDefault();pasteSelection();return;}if(cmd&&k==="d"){e.preventDefault();duplicateIds([...selectedComponents]);return;}if(cmd&&k==="s"){e.preventDefault();saveEditor();return;}if(e.key==="Escape"){deselect();return;}if(e.key==="Delete"||e.key==="Backspace"){e.preventDefault();deleteSelection();return;}if(!cmd&&k==="d"&&selectedEdge){const r=routes[selectedEdge];r.direction=r.direction==="target_to_source"?"source_to_target":"target_to_source";checkpoint();renderOverlay();}}
  window.addEventListener("message",e=>{const d=e.data;if(d&&d.type===RENDER)render(d.args||{});});window.addEventListener("resize",()=>{if(!argsState.fit_screen)requestAnimationFrame(()=>setHeight(true));});window.addEventListener("pointerdown",e=>{if(contextMenu&&!contextMenu.contains(e.target))closeContext();});root.addEventListener("keydown",keydown);ready();setTimeout(ready,120);setHeight(true);setTimeout(()=>setHeight(true),250);
})();
