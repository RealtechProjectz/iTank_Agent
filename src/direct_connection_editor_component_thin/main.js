(() => {
  "use strict";
  const READY="streamlit:componentReady", SET_VALUE="streamlit:setComponentValue", SET_HEIGHT="streamlit:setFrameHeight", RENDER="streamlit:render";
  const root=document.getElementById("root");
  let argsState={}, routes={}, components={}, selectedEdge=null, selectedComponents=new Set(), clipboard=[], drag=null, zoom=1, panX=0, panY=0, snap=true, grid=.25, lastHeight=-1, contextMenu=null, initialSnapshot=null, history=[], historyIndex=-1, dirty=false, routeIdsByComponent=new Map(), lastRenderRevision="", overlayRenderQueued=false;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const clonePoints=p=>(p||[]).map(q=>[Number(q[0]),Number(q[1])]);
  const cloneBox=b=>Array.isArray(b)&&b.length===4?b.map(Number):[0,0,1,1];
  const eid=()=>`${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  let dragOnlyWindowListeners=[];
  let dragOnlyRouteAction=null;

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
  function saveMovementDraft(){
    const key=movementDraftStorageKey();
    if(!key)return;
    try{
      sessionStorage.setItem(key,JSON.stringify({
        route_draft_version:"orthogonal-flowchart-v74-arrow-endpoint-drag",
        routes:Object.values(routes).map(r=>({
          edge_id:String(r.edge_id||""),
          points:clonePoints(r.points)
        })),
        components:Object.values(components).map(c=>({
          instance_id:String(c.instance_id||""),
          box:cloneBox(c.box)
        }))
      }));
    }catch(_){}
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
    const restoreRoutes=saved.route_draft_version==="orthogonal-flowchart-v74-arrow-endpoint-drag";
    const savedRoutes=new Map((saved.routes||[]).map(r=>[String(r.edge_id||""),r]));
    const savedComponents=new Map((saved.components||[]).map(c=>[String(c.instance_id||""),c]));

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

    Object.values(routes).forEach(r=>{
      delete r.arrow_control;
      if(!restoreRoutes)return;
      const s=savedRoutes.get(String(r.edge_id||""));
      if(!s)return;
      if(Array.isArray(s.points)&&s.points.length>=2)r.points=clonePoints(s.points);
    });

    if(restoreRoutes){
      Object.values(components).forEach(c=>{
        const s=savedComponents.get(String(c.instance_id||""));
        if(s&&Array.isArray(s.box)&&s.box.length===4)c.box=cloneBox(s.box);
      });

      // Re-anchor only terminal coordinates. Interior routing, manual bends,
      // arrow behavior, line style and all current drag logic remain untouched.
      Object.values(routes).forEach(r=>{
        if(!Array.isArray(r.points)||r.points.length<2)return;
        const edgeId=String(r.edge_id||"");
        const sourceId=String(r.source||"");
        const targetId=String(r.target||"");
        const sourceBox=components[sourceId]?.box;
        const targetBox=components[targetId]?.box;
        const wasSaved=savedRoutes.has(edgeId);
        const generatedRefs=generatedPortRefs.get(edgeId)||{};

        if(Array.isArray(sourceBox)&&sourceBox.length===4){
          const sourceRef=wasSaved
            ?draftPortReference(sourceBox,r.points[0])
            :generatedRefs.source;
          const sourcePort=draftResolvePortReference(sourceBox,sourceRef);
          if(sourcePort)r.points=draftAttachEndpoint(r.points,true,sourcePort);
        }

        if(Array.isArray(targetBox)&&targetBox.length===4){
          const last=r.points.length-1;
          const targetRef=wasSaved
            ?draftPortReference(targetBox,r.points[last])
            :generatedRefs.target;
          const targetPort=draftResolvePortReference(targetBox,targetRef);
          if(targetPort)r.points=draftAttachEndpoint(r.points,false,targetPort);
        }
      });
    }else{
      // Remove the incompatible snapshot so the next drag starts from the
      // current generated diagram as one consistent component+route state.
      try{sessionStorage.removeItem(key);}catch(_){}
    }
  }
  function snapshot(){return {routes:Object.values(routes).map(r=>({...r,points:clonePoints(r.points),original_points:clonePoints(r.original_points||r.points)})),components:Object.values(components).map(c=>({...c,box:cloneBox(c.box)}))};}
  function applySnapshot(state){routes={};components={};for(const r of (state?.routes||[])){const id=String(r.edge_id||"");if(id)routes[id]={...r,edge_id:id,points:clonePoints(r.points),original_points:clonePoints(r.original_points||r.points),hidden:!!r.hidden};}for(const c of (state?.components||[])){const id=String(c.instance_id||"");if(id)components[id]={...c,instance_id:id,box:cloneBox(c.box),hidden:!!c.hidden};}rebuildRouteConnectionIndex();selectedEdge=null;selectedComponents.clear();renderOverlay();}
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
  function componentAt(p,exclude=null){const vals=Object.values(components).reverse();for(const c of vals){if(!c.hidden&&c.instance_id!==exclude&&pointInBox(p,c.box))return c;}return null;}
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
    for(const candidate of Object.values(components)){
      if(!candidate||candidate.hidden||String(candidate.instance_id||"")===String(activeDrag?.id||""))continue;
      if(candidate.__oht_attached_sensor)continue;
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

  function reanchorComponentRoutes(instanceId,fromBox,toBox){
    const componentId=String(instanceId||"");
    if(!componentId)return;
    for(const route of connectedRoutes(componentId)){
      if(!Array.isArray(route.points)||route.points.length<2)continue;
      const isSource=String(route.source||"")===componentId;
      const endpoint=isSource?route.points[0]:route.points[route.points.length-1];
      const portRef=draftPortReference(fromBox,endpoint);
      const portPoint=draftResolvePortReference(toBox,portRef);
      if(portPoint)route.points=draftAttachEndpoint(route.points,isSource,portPoint);
    }
  }

  function prepareOhtTankSensorAttachments(){
    const componentName=id=>String(components[String(id||"")]?.component||"");
    const allRoutes=Object.values(routes).filter(Boolean);

    Object.values(components).forEach(component=>{
      if(!component)return;
      delete component.__oht_attached_sensor;
      delete component.__oht_parent_id;
    });

    const ohtToTransmitters=allRoutes.filter(route=>
      componentName(route.source)==="OHT Tank" &&
      componentName(route.target)==="Transmitter"
    );
    const transmitterToSensors=allRoutes.filter(route=>
      componentName(route.source)==="Transmitter" &&
      componentName(route.target)==="Linear Level Sensor (LLS)"
    );

    const usedSensorIds=new Set();
    for(const tankRoute of ohtToTransmitters){
      const tankId=String(tankRoute.source||"");
      const transmitterId=String(tankRoute.target||"");
      const sensorRoute=transmitterToSensors.find(route=>
        String(route.source||"")===transmitterId &&
        !usedSensorIds.has(String(route.target||""))
      );
      if(!sensorRoute)continue;

      const sensorId=String(sensorRoute.target||"");
      const tank=components[tankId];
      const transmitter=components[transmitterId];
      const sensor=components[sensorId];
      if(!tank||!sensor)continue;

      usedSensorIds.add(sensorId);
      sensor.__oht_attached_sensor=true;
      sensor.__oht_parent_id=tankId;

      // When either existing OHT sensor link is deleted, hide only this attached
      // visual sensor. The saved component/project data remains untouched.
      const attachmentActive=
        !tank.hidden &&
        !transmitter?.hidden &&
        !tankRoute.hidden &&
        !sensorRoute.hidden;
      if(!attachmentActive){
        sensor.hidden=true;
        continue;
      }

      const previousBox=cloneBox(sensor.box);
      const attachedBox=ohtAttachedSensorBox(tank.box);
      sensor.box=attachedBox;
      reanchorComponentRoutes(sensorId,previousBox,attachedBox);
    }
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
  function drawComponent(g,svg,c){const [x,y,w,h]=c.box,img=svgEl("image",{x,y,width:w,height:h,href:`data:image/png;base64,${c.image_b64||""}`,class:"component-image",preserveAspectRatio:"none"});img.addEventListener("click",e=>{e.stopPropagation();selectComponent(c.instance_id,e.shiftKey||e.ctrlKey||e.metaKey);});img.addEventListener("contextmenu",e=>{e.preventDefault();e.stopPropagation();if(!selectedComponents.has(c.instance_id))selectComponent(c.instance_id,false);openContext(e.clientX,e.clientY,"component",c.instance_id);});img.addEventListener("pointerdown",e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();if(!selectedComponents.has(c.instance_id))selectComponent(c.instance_id,e.shiftKey||e.ctrlKey||e.metaKey);const p=clientToCanvas(svg,e),ids=[...selectedComponents],boxes=Object.fromEntries(ids.map(id=>[id,cloneBox(components[id].box)])),routeBase=Object.fromEntries(Object.values(routes).map(r=>[r.edge_id,clonePoints(r.points)]));drag={kind:"components",ids,start:p,boxes,routeBase,pid:e.pointerId};try{svg.setPointerCapture(e.pointerId);}catch(_){}});g.appendChild(img);}
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
  function openContext(x,y,type,id){closeContext();const menu=document.createElement("div");menu.className="context";menu.style.left=`${Math.min(x,window.innerWidth-170)}px`;menu.style.top=`${Math.min(y,window.innerHeight-180)}px`;const add=(label,fn,danger=false)=>{const b=document.createElement("button");b.type="button";b.textContent=label;if(danger)b.className="danger";b.addEventListener("click",()=>{fn();closeContext();});menu.appendChild(b);};if(type==="edge"){add("Reverse direction",()=>{const r=routes[id];r.direction=r.direction==="target_to_source"?"source_to_target":"target_to_source";checkpoint();renderOverlay();});add("Reset route",()=>{const r=routes[id];r.points=clonePoints(r.original_points||r.points);r.direction=r.original_direction||"source_to_target";r.hidden=false;checkpoint();renderOverlay();});add("Delete connection",()=>{const r=routes[id];if(!r)return;if(argsState.drag_only){r.hidden=true;selectedEdge=null;emit("connection_delete",{edge_id:id});}else{r.hidden=true;selectedEdge=null;checkpoint();renderOverlay();}},true);}else{add("Duplicate",()=>duplicateIds([...selectedComponents]));add("Copy",()=>{clipboard=[...selectedComponents];});add("Delete",()=>deleteSelection(),true);}document.body.appendChild(menu);contextMenu=menu;}
  function openContext(x,y,type,id){closeContext();const menu=document.createElement("div");menu.className="context";menu.style.left=`${Math.min(x,window.innerWidth-170)}px`;menu.style.top=`${Math.min(y,window.innerHeight-180)}px`;const add=(label,fn,danger=false)=>{const b=document.createElement("button");b.type="button";b.textContent=label;if(danger)b.className="danger";b.addEventListener("click",()=>{fn();closeContext();});menu.appendChild(b);};if(type==="edge"){add("Reverse direction",()=>{const r=routes[id];r.direction=r.direction==="target_to_source"?"source_to_target":"target_to_source";checkpoint();renderOverlay();});add("Reset route",()=>{const r=routes[id];r.points=clonePoints(r.original_points||r.points);r.direction=r.original_direction||"source_to_target";r.hidden=false;checkpoint();renderOverlay();});add("Delete connection",()=>{const r=routes[id];if(!r)return;if(argsState.drag_only){if(dragOnlyRouteAction)dragOnlyRouteAction.remove(id);else r.hidden=true;emit("connection_delete",{edge_id:id});}else{r.hidden=true;selectedEdge=null;checkpoint();renderOverlay();}},true);}else{add("Duplicate",()=>duplicateIds([...selectedComponents]));add("Copy",()=>{clipboard=[...selectedComponents];});add("Delete",()=>deleteSelection(),true);}document.body.appendChild(menu);contextMenu=menu;}
  function closeContext(){if(contextMenu){contextMenu.remove();contextMenu=null;}}
  function deleteSelection(){
    if(argsState.drag_only&&dragOnlyRouteAction&&dragOnlyRouteAction.selected){
      const edgeId=dragOnlyRouteAction.selected;
      dragOnlyRouteAction.remove(edgeId);
      emit("connection_delete",{edge_id:edgeId});
      return;
    }
    // Delete a selected connection by itself, exactly as before.
    if(selectedEdge){
      const edge=routes[selectedEdge];
      if(edge){
        if(argsState.drag_only&&dragOnlyRouteAction){
          dragOnlyRouteAction.remove(selectedEdge);
        }else{
          edge.hidden=true;
        }
        if(argsState.drag_only){
          emit("connection_delete",{edge_id:selectedEdge});
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
  async function saveEditor(){const b=document.getElementById("saveEditorBtn");if(b){b.disabled=true;b.textContent="Saving...";}try{const image_b64=await composeEditedPng();emit("save_editor",{image_b64,routes:Object.values(routes).map(r=>({...r,points:clonePoints(r.points)})),components:Object.values(components).map(c=>({...c,box:cloneBox(c.box)})),canvas_width:canvasSize()[0],canvas_height:canvasSize()[1]});}catch(err){console.error(err);alert("Could not save the edited diagram. Please try again.");if(b){b.disabled=false;b.textContent="Save";}}}
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
        routes[rid]={
          edge_id:rid,label:"Manual connection",source:d.source,target:target.instance_id,
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

    // Worksheet fill fix only:
    // In the normal Worksheet app.py passes fixed_screen_height=None.
    // Use the existing iframe/Worksheet height instead of silently creating
    // a separate 700px surface, which was pushing the rendered diagram down.
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
        dragOnlyRouteAction.remove(edgeId);
        emit("connection_delete",{edge_id:edgeId});
      });
      stage.appendChild(deleteRouteButton);
      dragOnlyRouteAction={
        selected:null,
        select(edgeId){
          this.selected=String(edgeId||"");
          deleteRouteButton.style.display=this.selected?"block":"none";
          for(const [id,visual] of routeVisuals){
            const active=id===this.selected;
            visual.line.setAttribute("stroke",active?"#0a66e3":(routes[id]?.dotted?"#000000":"#123DBD"));
            visual.line.setAttribute("stroke-width",active?"0.026":"0.015");
            visual.under.setAttribute("stroke",active?"#b9d7ff":"#ffffff");
          }
        },
        remove(edgeId){
          const id=String(edgeId||"");
          const route=routes[id];
          if(!route)return;
          route.hidden=true;
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
          rebuildRouteConnectionIndex();
        }
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

      for(const route of Object.values(routes)){
        if(route.hidden)continue;
        const pts=Array.isArray(route.points)?route.points:[];
        if(pts.length<2)continue;
        const edgeId=String(route.edge_id||"");
        const visiblePts=arrowVisiblePoints(route);
        const points=visiblePts
          .map(p=>`${Number(p[0]||0)},${Number(p[1]||0)}`)
          .join(" ");

        const under=routeEl("polyline",{
          points,fill:"none",stroke:"#ffffff","stroke-width":"0.030",
          "stroke-linejoin":"round","stroke-linecap":"round",
          "pointer-events":"none"
        });
        routeSvg.appendChild(under);

        const line=routeEl("polyline",{
          points,fill:"none",
          stroke:route.dotted?"#000000":"#123DBD",
          "stroke-width":"0.015","stroke-linejoin":"round","stroke-linecap":"round",
          "stroke-opacity":"1",
          "pointer-events":"none"
        });
        if(route.dotted)line.setAttribute("stroke-dasharray","0.026 0.052");
        const direction=String(route.direction||"source_to_target");
        routeSvg.appendChild(line);

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
        routeSvg.appendChild(arrowVisual);

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
          stroke:"transparent",
          "stroke-width":"14",
          "vector-effect":"non-scaling-stroke",
          "stroke-linejoin":"round",
          "stroke-linecap":"round",
          style:"pointer-events:stroke;cursor:grab;touch-action:none;"
        });
        hit.dataset.edgeId=edgeId;
        routeSvg.appendChild(hit);

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

        hit.addEventListener("contextmenu",e=>{
          e.preventDefault();
          e.stopPropagation();
          if(!route.hidden){
            if(dragOnlyRouteAction)dragOnlyRouteAction.select(edgeId);
            openContext(e.clientX,e.clientY,"edge",edgeId);
          }
        });

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
    };
    drawDragOnlyRoutes();

    const pendingId=String(argsState.pending_connection_source_id||"");
    let activeDrag=null;
    const hoverTimers=new Map();
    const overlays=new Map();
    const componentLabels=new Map();
    const componentVisuals=new Map();
    let activeLabelEditor=null;

    const finishLabelEdit=(save=true)=>{
      if(!activeLabelEditor)return;
      const editor=activeLabelEditor;
      activeLabelEditor=null;
      const next=String(editor.input.value||"").trim();
      editor.input.remove();
      editor.labelPair.main.style.display="";
      editor.labelPair.under.style.display="";
      if(!save||!next||next===editor.original)return;
      editor.component.title=next;
      editor.labelPair.main.textContent=next;
      editor.labelPair.under.textContent=next;
      emit("component_label_edit",{instance_id:editor.id,title:next});
    };

    const beginLabelEdit=(id,labelPair,event)=>{
      if(activeLabelEditor)finishLabelEdit(true);
      const component=components[id];
      if(!component||!labelPair)return;
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
    };

    const canvasPoint=(ev)=>{
      const r=stage.getBoundingClientRect();
      if(!r.width||!r.height)return[0,0];
      return[
        clamp((ev.clientX-r.left)/r.width*cw,0,cw),
        clamp((ev.clientY-r.top)/r.height*ch,0,ch)
      ];
    };

    const makeGhostFromPreview=(component)=>{
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

    const setComponentControlsVisible=(id,visible)=>{
      const item=overlays.get(String(id||""));
      if(!item)return;
      item.add.style.opacity=visible?"1":"0";
      item.add.style.pointerEvents=visible?"auto":"none";
      item.del.style.opacity=visible?"1":"0";
      item.del.style.pointerEvents=visible?"auto":"none";
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

    for(const c of Object.values(components)){
      if(c.hidden)continue;
      const id=String(c.instance_id||"");
      if(!id)continue;

      // Actual visible component layer. This is deliberately separate from the
      // transparent pointer target so the component itself moves immediately.
      const visual=document.createElement("img");
      visual.draggable=false;
      visual.alt=String(c.title||c.component||id);
      visual.src=`data:image/png;base64,${String(c.image_b64||"").trim()}`;
      visual.style.cssText=`position:absolute;z-index:${c.__oht_attached_sensor?18:15};pointer-events:none;user-select:none;object-fit:${String(c.image_fit||"contain")};`;
      applyVisibleComponentImageBox(visual,c.box);
      stage.appendChild(visual);
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
      labelMain.addEventListener("click",event=>beginLabelEdit(id,{under:labelUnder,main:labelMain},event));
      labelUnder.addEventListener("click",event=>beginLabelEdit(id,{under:labelUnder,main:labelMain},event));

      const hit=document.createElement("div");
      hit.dataset.componentId=id;
      hit.title=String(c.title||c.component||id);
      hit.style.cssText="position:absolute;z-index:50;box-sizing:border-box;cursor:grab;background:rgba(0,0,0,0.001);touch-action:none;pointer-events:auto;-webkit-user-select:none;user-select:none;";
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
      add.style.cssText="position:absolute;right:-13px;top:-13px;width:30px;height:30px;border-radius:50%;border:2px solid #fff;background:#0a66e3;color:#fff;font:bold 21px/24px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);z-index:30;opacity:0;pointer-events:none;cursor:pointer;padding:0;";

      const del=document.createElement("button");
      del.type="button";
      del.textContent="×";
      del.title="Delete component";
      del.style.cssText="position:absolute;left:-13px;top:-13px;width:30px;height:30px;border-radius:50%;border:2px solid #fff;background:#dc2626;color:#fff;font:bold 20px/24px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);z-index:30;opacity:0;pointer-events:none;cursor:pointer;padding:0;";

      add.addEventListener("pointerdown",e=>{e.preventDefault();e.stopPropagation();});
      del.addEventListener("pointerdown",e=>{e.preventDefault();e.stopPropagation();});
      add.addEventListener("click",e=>{
        e.preventDefault();e.stopPropagation();
        optimisticWorksheetAdd(c);
        emit("component_add",{component:String(c.component||""),instance_id:id});
      });
      del.addEventListener("click",e=>{
        e.preventDefault();e.stopPropagation();
        optimisticWorksheetDelete(id);
        emit("component_delete",{component:String(c.component||""),instance_id:id});
      });

      hit.addEventListener("pointerenter",()=>{
        showControlsForTwoSeconds(id);
      });
      hit.addEventListener("pointerleave",()=>{
        // Intentionally do not hide/cancel here. The controls must remain visible
        // for the full 2 seconds from the original hover/touch moment.
      });

      hit.addEventListener("pointerdown",e=>{
        if(e.button!==0&&e.pointerType!=="touch"&&e.pointerType!=="pen")return;
        if(e.target===add||e.target===del)return;

        if(e.pointerType==="touch"||e.pointerType==="pen"){
          showControlsForTwoSeconds(id,{persist:true});
        }

        e.preventDefault();
        e.stopPropagation();

        const start=canvasPoint(e);
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
          start,
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
          ghost:makeGhostFromPreview(c)
        };
        stage.appendChild(activeDrag.ghost);
        hit.style.cursor="grabbing";
        hit.style.outline="2px dashed #0a66e3";
        hit.style.outlineOffset="2px";
        try{hit.setPointerCapture(e.pointerId);}catch(_){}
      });

      const moveActiveDrag=e=>{
        if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==e.pointerId)return;
        e.preventDefault();
        e.stopPropagation();

        const p=canvasPoint(e);
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
        const nx=snappedBox[0];
        const ny=snappedBox[1];

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
            const portRefs=childState.routePortRefs?.[edgeId]||{};
            if(String(route.source||"")===childState.id){
              const sourcePort=resolvePortReference(child.box,portRefs.source);
              if(sourcePort){
                route.points=moveConnectedRouteEndpointToPort(
                  route.points,true,sourcePort
                );
              }
            }
            if(String(route.target||"")===childState.id){
              const targetPort=resolvePortReference(child.box,portRefs.target);
              if(targetPort){
                route.points=moveConnectedRouteEndpointToPort(
                  route.points,false,targetPort
                );
              }
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

          if(String(route.source||"")===id){
            const sourcePort=resolvePortReference(c.box,portRefs.source);
            if(sourcePort){
              route.points=moveConnectedRouteEndpointToPort(
                route.points,true,sourcePort
              );
            }
          }

          if(String(route.target||"")===id){
            const targetPort=resolvePortReference(c.box,portRefs.target);
            if(targetPort){
              route.points=moveConnectedRouteEndpointToPort(
                route.points,false,targetPort
              );
            }
          }

          // Maintain a clean right-angle route while the component moves.
          route.points=cleanDraggedRoutePoints(route.points);
          refreshArrowAngleFromCurrentGeometry(route);

          // Update the already-existing SVG nodes in place for a live drag.
          updateRouteVisual(edgeId);
        }

        activeDrag.moved=activeDrag.moved||Math.hypot(nx-bx,ny-by)>.02;
      };

      let dragFrame=0;
      let pendingDragEvent=null;
      const scheduleActiveDragMove=e=>{
        if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==e.pointerId)return;
        e.preventDefault();
        e.stopPropagation();
        pendingDragEvent=e;
        if(dragFrame)return;
        dragFrame=requestAnimationFrame(()=>{
          dragFrame=0;
          const next=pendingDragEvent;
          pendingDragEvent=null;
          if(next)moveActiveDrag(next);
        });
      };
      const flushActiveDragMove=()=>{
        if(!dragFrame)return;
        cancelAnimationFrame(dragFrame);
        dragFrame=0;
        const next=pendingDragEvent;
        pendingDragEvent=null;
        if(next)moveActiveDrag(next);
      };

      hit.addEventListener("pointermove",scheduleActiveDragMove);
      stage.addEventListener("pointermove",scheduleActiveDragMove);

      const finish=e=>{
        if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==e.pointerId)return;
        flushActiveDragMove();
        e.preventDefault();
        e.stopPropagation();

        const d=activeDrag;
        activeDrag=null;
        try{hit.releasePointerCapture(e.pointerId);}catch(_){}
        if(d.ghost&&d.ghost.parentNode)d.ghost.parentNode.removeChild(d.ghost);
        hit.style.cursor="grab";
        hit.style.outline=id===pendingId?"3px solid #0a66e3":"none";
        hit.style.outlineOffset=id===pendingId?"2px":"0";

        if(d.moved){
          // Do not notify Streamlit for movement. The component stays exactly at
          // its dropped position and the current page does not rerun/reload.
          saveMovementDraft();
          suppressComponentClick=true;
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
        emit("component_select",{
          instance_id:id,
          component:String(c.component||"")
        });
      });
      hit.addEventListener("pointercancel",e=>{
        if(!activeDrag||activeDrag.id!==id||activeDrag.pointerId!==e.pointerId)return;
        if(dragFrame)cancelAnimationFrame(dragFrame);
        dragFrame=0;
        pendingDragEvent=null;
        const d=activeDrag;
        activeDrag=null;
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

        // A cancelled component drag must also restore the exact connected-line
        // geometry that existed when the drag started.
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
      });

      hit.appendChild(add);
      hit.appendChild(del);
      stage.appendChild(hit);
      overlays.set(id,{hit,add,del,visual});
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
        optimisticWorksheetAdd(item);
        emit("component_add",{component:String(item.component||""),instance_id:itemId});
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

  function render(args){
    const incoming=args||{};
    const revision=String(incoming.render_revision||"");
    const compact=!!incoming.compact_payload;

    // Streamlit reruns can resend this component dozens of times while the
    // Worksheet visual state itself has not changed. In compact mode Python
    // intentionally omits the large background PNG, component sprites and
    // route arrays. Preserve the already-mounted heavy payload instead of
    // replacing it with the compact placeholders.
    if(revision&&revision===lastRenderRevision&&compact){
      argsState={...argsState,...incoming,
        image_b64:argsState.image_b64||"",
        routes:argsState.routes||[],
        hotspots:argsState.hotspots||[],
        components:argsState.components||[]
      };
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
      argsState=incoming;
      return;
    }
    argsState=incoming;
    lastRenderRevision=revision;
    routes={};components={};selectedEdge=null;selectedComponents.clear();drag=null;zoom=1;panX=0;panY=0;
    const saved=(argsState.edit_mode&&argsState.editor_state&&Array.isArray(argsState.editor_state.routes)&&Array.isArray(argsState.editor_state.components))?argsState.editor_state:null;
    const rr=saved?saved.routes:(argsState.routes||[]),cc=saved?saved.components:(argsState.components||[]);
    rr.forEach(r=>{const id=String(r.edge_id||"");if(id)routes[id]={...r,edge_id:id,points:clonePoints(r.points),original_points:clonePoints(r.original_points||r.points),hidden:!!r.hidden};});
    cc.forEach(c=>{const id=String(c.instance_id||"");if(id)components[id]={...c,instance_id:id,box:cloneBox(c.box),hidden:!!c.hidden};});
    rebuildRouteConnectionIndex();
    if(argsState.drag_only){
      restoreMovementDraft();
      prepareOhtTankSensorAttachments();
    }
    if(argsState.edit_mode){initialSnapshot=snapshot();history=[JSON.parse(JSON.stringify(initialSnapshot))];historyIndex=0;dirty=false;renderEditor();}
    else if(argsState.drag_only){renderDragOnly();}
    else renderNormal();
  }
  function keydown(e){if(["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName))return;const cmd=e.ctrlKey||e.metaKey,k=String(e.key||"").toLowerCase();if(cmd&&k==="z"){e.preventDefault();e.shiftKey?redoLocal():undoLocal();return;}if(cmd&&k==="y"){e.preventDefault();redoLocal();return;}if(cmd&&k==="c"){e.preventDefault();copySelection();return;}if(cmd&&k==="v"){e.preventDefault();pasteSelection();return;}if(cmd&&k==="d"){e.preventDefault();duplicateIds([...selectedComponents]);return;}if(cmd&&k==="s"){e.preventDefault();saveEditor();return;}if(e.key==="Escape"){deselect();return;}if(e.key==="Delete"||e.key==="Backspace"){e.preventDefault();deleteSelection();return;}if(!cmd&&k==="d"&&selectedEdge){const r=routes[selectedEdge];r.direction=r.direction==="target_to_source"?"source_to_target":"target_to_source";checkpoint();renderOverlay();}}
  window.addEventListener("message",e=>{const d=e.data;if(d&&d.type===RENDER)render(d.args||{});});window.addEventListener("resize",()=>{if(!argsState.fit_screen)requestAnimationFrame(()=>setHeight(true));});window.addEventListener("pointerdown",e=>{if(contextMenu&&!contextMenu.contains(e.target))closeContext();});root.addEventListener("keydown",keydown);ready();setTimeout(ready,120);setHeight(true);setTimeout(()=>setHeight(true),250);
})();
