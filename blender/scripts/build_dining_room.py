"""Deterministically build Dining Table Run: game route + Blender mesh share one sampler.

Run with factory-startup. Authoring uses X/right, -Y/game-forward, Z/up. The route
is published first; GLB/source/report are replaced only after validation succeeds.
All scenery is original geometry; no add-ons, downloaded assets or textures.
"""
from __future__ import annotations
import bisect
import hashlib
import json
import math
import os
import random
from pathlib import Path
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
JSON_PATH = ROOT / 'src/dining-track.json'
GLB_PATH = ROOT / 'public/assets/maps/dining-table-run.glb'
BLEND_PATH = ROOT / 'blender/source/dining-table-run.blend'
CARD_PATH = ROOT / 'public/assets/cards/dining-table-run.png'
REPORT_PATH = ROOT / 'blender/dining-room-report.json'
OVERVIEW_PATH = ROOT / 'public/assets/cards/dining-table-run-overview.png'
SEGMENTS = 1024
WIDTH = 5.94
LANE_SPACING = 1.35
WORLD_PER_PROGRESS = .73
random.seed(17)

# Sparse authoring controls are deliberately broad: minimum 3-D radius > 12.
CONTROLS = [(-22,.65,-25,0),(0,.65,-25,0),(22,.65,-25,0),
 (38,.85,-21,-.08),(46,2.5,-9,-.14),(46,6,8,-.12),(37,6,21,-.12),
 (20,3,25,-.06),(0,.65,25,0),(-20,.65,25,-.04),(-36,.65,20,-.10),
 (-46,.65,7,-.12),(-46,.65,-9,-.10),(-38,.65,-21,-.06)]

def cat(a,b,c,d,t):
    return .5*(2*b+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t)

def tangent(a,b,c,d,t):
    return .5*((-a+c)+2*(2*a-5*b+4*c-d)*t+3*(-a+3*b-3*c+d)*t*t)

def raw_position(i,t):
    n=len(CONTROLS)
    return tuple(cat(CONTROLS[(i-1)%n][k],CONTROLS[i][k],CONTROLS[(i+1)%n][k],CONTROLS[(i+2)%n][k],t) for k in range(4))

def route_document():
    distances=[]
    for i in range(len(CONTROLS)):
        samples=[raw_position(i,j/200) for j in range(201)]
        distances.append(sum(math.dist(a[:3],b[:3]) for a,b in zip(samples,samples[1:])))
    length=sum(distances)/WORLD_PER_PROGRESS
    path=[];progress=0
    for i,c in enumerate(CONTROLS):
        path.append(dict(progress=round(progress,6),x=c[0],y=c[1],z=c[2],bank=c[3]))
        progress+=distances[i]/WORLD_PER_PROGRESS
    return {'schemaVersion':1,'id':'dining-table-run','version':'1.0.0','length':round(length,6),
      'lanes':[{'index':i} for i in range(4)],'startFinish':0,
      'checkpoints':[{'id':'checkpoint-east-bridge','progress':path[5]['progress']},
       {'id':'checkpoint-table-tunnel','progress':path[8]['progress']},
       {'id':'checkpoint-west-sweeper','progress':path[11]['progress']}],
      'fixedObstacles':[],
      'powerUpOpportunities':[{'id':key,'progress':progress,'spawnRadius':radius,'allowedEffects':['boost','shield','hazard']}
       for key,progress,radius in [('pickup-bridge',60,10),('pickup-home',30,12),('pickup-table',187,6),('pickup-west',233,10)]],
      'hazardPlacementLocations':[{'id':key,'progress':round(length*f,6),'allowedLanes':[0,1,2,3]}
       for key,f in [('hazard-bridge',.39),('hazard-home',.13),('hazard-table',.65),('hazard-west',.87)]],
      'corners':[{'id':'corner-east','fromProgress':path[3]['progress'],'toProgress':path[7]['progress'],'laneSpeedLimits':[19,18,17,16]},
       {'id':'corner-west','fromProgress':path[10]['progress'],'toProgress':path[0]['progress'],'laneSpeedLimits':[19,18,17,16]}],
      'presentation':{'path':path}}

ROUTE=route_document()
PATH=ROUTE['presentation']['path']
KNOTS=[p['progress'] for p in PATH]
LENGTH=ROUTE['length']

def frame(progress):
    p=progress%LENGTH;i=bisect.bisect_right(KNOTS,p)-1;n=len(PATH)
    a,b,c,d=PATH[(i-1)%n],PATH[i],PATH[(i+1)%n],PATH[(i+2)%n]
    end=LENGTH if i==n-1 else c['progress'];t=(p-b['progress'])/(end-b['progress'])
    v=Vector(tuple(cat(a[k],b[k],c[k],d[k],t) for k in ('x','y','z')))
    dv=Vector(tuple(tangent(a[k],b[k],c[k],d[k],t) for k in ('x','y','z')))
    bank=cat(a['bank'],b['bank'],c['bank'],d['bank'],t)
    mag=math.hypot(dv.x,dv.z) or 1
    # EXACT runtime lane offset: horizontal tangent + vertical bank, not a rotated Frenet frame.
    lateral=Vector((-dv.z/mag*math.cos(bank), math.sin(bank), dv.x/mag*math.cos(bank)))
    normal=lateral.cross(dv.normalized()).normalized()
    return v,lateral,normal,dv.normalized()

def bp(game): return Vector((game[0],-game[2],game[1]))

def material(name,color,rough=.65,metal=0,emission=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
    node=m.node_tree.nodes.get('Principled BSDF')
    node.inputs['Base Color'].default_value=(*color,1)
    node.inputs['Roughness'].default_value=rough;node.inputs['Metallic'].default_value=metal
    if emission:
        node.inputs['Emission Color'].default_value=(*color,1);node.inputs['Emission Strength'].default_value=emission
    return m

M={}
BOX_PROXIES={}

def mesh(name,verts,faces,mats,indices=None):
    data=bpy.data.meshes.new(name+'-mesh');data.from_pydata(verts,[],faces);data.update()
    obj=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(obj);obj.parent=ROOM
    for m in mats: data.materials.append(m)
    if indices:
        for p,mi in zip(data.polygons,indices):p.material_index=mi
    return obj

class Boxes:
    def __init__(self,name,mats):self.name=name;self.mats=mats;self.v=[];self.f=[];self.mi=[];self.proxies=[]
    def add(self,center,size,mat=0):
        x,y,z=center;w,h,d=[s/2 for s in size];base=len(self.v)
        self.proxies.append((Vector((x-w,y-h,z-d)),Vector((x+w,y+h,z+d))))
        self.v += [bp((x+sx*w,y+sy*h,z+sz*d)) for sx,sy,sz in [(-1,-1,-1),(-1,-1,1),(-1,1,1),(-1,1,-1),(1,-1,-1),(1,-1,1),(1,1,1),(1,1,-1)]]
        self.f += [tuple(base+i for i in face) for face in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(1,2,6,5),(0,4,7,3)]];self.mi += [mat]*6
    def finish(self,bevel=0):
        o=mesh(self.name,self.v,self.f,self.mats,self.mi)
        BOX_PROXIES[self.name]=self.proxies
        if bevel:
            mod=o.modifiers.new('small-moulded-edge','BEVEL');mod.width=bevel;mod.segments=2
            bpy.context.view_layer.objects.active=o;o.select_set(True);bpy.ops.object.modifier_apply(modifier=mod.name);o.select_set(False)
        return o

def box(name,center,size,mat,bevel=0):
    b=Boxes(name,[mat]);b.add(center,size);return b.finish(bevel)

def cylinder(name,center,radius,depth,mat,vertices=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=depth,location=bp(center))
    o=bpy.context.object;o.name=name;o.data.materials.append(mat);o.parent=ROOM;return o

def sphere(name,center,radius,mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=radius,location=bp(center))
    o=bpy.context.object;o.name=name;o.data.materials.append(mat);o.parent=ROOM
    for p in o.data.polygons:p.use_smooth=True
    return o

def ribbon(name,offset,width,mat,height=0,segments=SEGMENTS,depth=0):
    v=[];f=[]
    for j in range(segments):
        p,r,n,_=frame(LENGTH*j/segments)
        for d in (offset-width/2,offset+width/2):v.append(bp(p+r*d+n*height))
    for j in range(segments):k=(j+1)%segments;f.append((2*j,2*j+1,2*k+1,2*k))
    if depth:
        count=len(v);v+=[x.copy() for x in v]
        for j in range(segments):
            _,_,n,_=frame(LENGTH*j/segments)
            for k in (0,1):v[count+2*j+k]-=bp(n)*depth
        for j in range(segments):
            k=(j+1)%segments;f.extend([(count+2*j,count+2*k,count+2*k+1,count+2*j+1),(2*j,2*k,count+2*k,count+2*j),(2*j+1,count+2*j+1,count+2*k+1,2*k+1)])
    return mesh(name,v,f,[mat])

def road():
    # Recessed slot geometry at each authoritative lane centre (9cm wide, 5cm deep).
    section=[(-WIDTH/2,0)]
    for lane in range(4):
        c=(lane-1.5)*LANE_SPACING
        section += [(c-.065,0),(c-.045,-.055),(c+.045,-.055),(c+.065,0)]
    section += [(WIDTH/2,0)]
    v=[];f=[];mi=[];row=len(section)
    for j in range(SEGMENTS):
        p,r,n,_=frame(LENGTH*j/SEGMENTS)
        v.extend(bp(p+r*offset+n*height) for offset,height in section)
    for j in range(SEGMENTS):
        k=(j+1)%SEGMENTS
        for q in range(row-1):
            f.append((j*row+q,j*row+q+1,k*row+q+1,k*row+q))
            mi.append(1 if section[q][1]<0 or section[q+1][1]<0 else 0)
    mesh('track-surface',v,f,[M['asphalt'],M['slot']],mi)
    ribbon('track-base',0,WIDTH+.20,M['blue'],height=-.10,depth=.22)
    for lane in range(4):
        c=(lane-1.5)*LANE_SPACING
        for side in (-1,1):ribbon(f'lane-{lane}-copper-{side}',c+side*.135,.055,M['copper'],height=.014)
    for side in (-1,1):
        ribbon(f'blue-edge-{side}',side*(WIDTH/2+.16),.28,M['edge'],height=.05,depth=.18)
        ribbon(f'edge-pinstripe-{side}',side*(WIDTH/2-.16),.065,M['ivory'],height=.014)
    # Alternating red/ivory kerb blocks occupy outer shoulder, never a car lane.
    v=[];f=[];mi=[]
    for j in range(256):
        for side in (-1,1):
            base=len(v)
            for p in (j/256,(j+.78)/256):
                center,r,n,_=frame(LENGTH*p)
                for d in (side*(WIDTH/2-.05),side*(WIDTH/2+.25)):
                    v.append(bp(center+r*d+n*.08))
            f.append((base,base+1,base+3,base+2));mi.append(j%2)
    mesh('segmented-shoulder-kerbs',v,f,[M['ivory'],M['coral']],mi)
    # Plastic section joiners every ~8 units: thin transverse seams follow exact frame.
    v=[];f=[]
    for j in range(34):
        center,r,n,d=frame(LENGTH*j/34);base=len(v)
        for along,across in [(-.018,-WIDTH/2),(-.018,WIDTH/2),(.018,WIDTH/2),(.018,-WIDTH/2)]:
            v.append(bp(center+r*across+d*along+n*.018))
        f.append(tuple(range(base,base+4)))
    mesh('road-panel-seams',v,f,[M['slot']])
    # East rise: vertical supports and caps end below track base, with lane envelope clear.
    supports=Boxes('bridge-blue-trestles',[M['blue'],M['edge']])
    for frac in (.255,.285,.315,.345,.375,.405,.435,.465):
        p,r,n,_=frame(LENGTH*frac)
        for side in (-1,1):
            x=p+r*side*2.55;top=x.y-.44
            if top>.20:supports.add((x.x,top/2,x.z),(.48,top,.48))
        supports.add((p.x,max(.1,p.y-.43),p.z),(4.9,.24,.75),1)
    supports.finish(.06)
    # Broad ramp hazard markings on the outside shoulder.
    arrows=Boxes('bridge-yellow-reflectors',[M['yellow']])
    for frac in (.28,.31,.34,.37,.40):
        p,r,n,_=frame(LENGTH*frac)
        for side in (-1,1):
            q=p+r*side*3.14+n*.18;arrows.add(tuple(q),(.18,.22,.35))
    arrows.finish(.035)

def household():
    # Planks are batched into one mesh with three materials, so grain comes from geometry.
    floor=Boxes('oak-floor-planks',[M['oak-a'],M['oak-b'],M['oak-c']])
    for zi in range(22):
        edges=[-64]+([x for x in range(-56,64,16)] if zi%2 else [x for x in range(-48,64,16)])+[64]
        for xi,(left,right) in enumerate(zip(edges,edges[1:])):
            floor.add(((left+right)/2,-.20,-42+zi*4),(right-left-.04,.32,3.96),(zi+xi)%3)
    floor.finish()
    box('floor-foundation',(0,-.43,0),(128,.18,88),M['oak-dark'])
    # One back wall and small return preserve a playable cutaway with no chase occlusion.
    box('sage-back-wall',(0,16,43.7),(128,32,.8),M['sage'])
    box('west-cutaway-return',(-63.7,5,35),(.8,10,17),M['sage'])
    trim=Boxes('ivory-room-trim',[M['ivory']]);trim.add((0,1.2,43.18),(128,2.4,.45));trim.add((-63.15,1.2,35),(.45,2.4,17));trim.add((0,31,43.1),(128,1.8,.55));trim.finish(.06)
    # Window/emissive sky, chunky crossbars, simple curtain panels.
    box('window-blue-sky',(-29,21,43.1),(26,16,.20),M['sky'])
    windows=Boxes('window-ivory-frame',[M['ivory']])
    for x in (-43,-29,-15):windows.add((x,21,42.85),(.8,17,.65))
    for y in (12.5,21,29.5):windows.add((-29,y,42.85),(29,.75,.65))
    windows.finish(.12)
    curtains=Boxes('terracotta-curtains',[M['cloth']])
    for x in (-46,-12):
        for dx in (-1.2,0,1.2):curtains.add((x+dx,21,42.3),(1.8,20,1.1))
    curtains.finish(.20)
    box('window-sill',(-29,12.2,42),(32,.6,2.6),M['ivory'],.15)
    # Raised table bridges the north straight: top underside17.1, highest nearby road<6.
    box('dining-table-top',(0,18,22),(62,1.8,30),M['walnut'],.55)
    apron=Boxes('dining-table-apron',[M['walnut-dark']])
    apron.add((0,16.4,8),(57,1.8,1));apron.add((0,16.4,36),(57,1.8,1))
    for x in (-29,29):apron.add((x,16.4,22),(1,1.8,28))
    apron.finish(.12)
    legs=Boxes('dining-table-legs',[M['walnut-dark']])
    for x in (-27,27):
        for z in (11,33):
            legs.add((x,8.5,z),(2.6,17,2.6));legs.add((x,.65,z),(3.2,1.3,3.2))
    legs.finish(.20)
    # Sculpted central runner, quilt seams and a front-only hanging fold.
    box('table-cloth-runner',(0,18.96,22),(12,.08,30.2),M['cloth'],.04)
    box('table-cloth-front-fold',(0,16.4,6.86),(12,5.2,.12),M['cloth'],.06)
    stitching=Boxes('cloth-stitched-border',[M['cream']])
    for x in (-5.55,5.55):stitching.add((x,19.015,22),(.10,.02,30))
    stitching.finish()
    # Both chairs sit well inside the course, outside every swept road envelope.
    for index,x in enumerate((-12,12)):
        chair=Boxes(f'dining-chair-{index}',[M['walnut'],M['walnut-dark']])
        chair.add((x,9,1),(12,1.4,12))
        for dx in (-4.6,4.6):
            for dz in (-4.6,4.6):chair.add((x+dx,4.3,1+dz),(1.1,8.6,1.1),1)
        for dx in (-4.6,4.6):chair.add((x+dx,14.0,-3.6),(1.1,11,1.1),1)
        for y in (12,16,19):chair.add((x,y,-3.6),(10,1.0,.8))
        chair.finish(.18)
        box(f'chair-{index}-seat-cushion',(x,9.8,1),(10,.7,10),M['teal'],.30)
    # A low-poly turned ceramic bowl with visible rim and fruit on the table.
    v=[];f=[];profile=[(0,0),(3.0,.15),(3.9,1.0),(4.4,2.5),(4.0,2.5),(3.6,1.1),(0,.7)]
    sides=48
    for rad,h in profile:
        for j in range(sides):
            a=j*math.tau/sides;v.append(bp((-12+rad*math.cos(a),19+h,23+rad*math.sin(a))))
    for i in range(len(profile)-1):
        for j in range(sides):k=(j+1)%sides;f.append((i*sides+j,i*sides+k,(i+1)*sides+k,(i+1)*sides+j))
    mesh('ceramic-fruit-bowl',v,f,[M['ceramic']])
    for i,(x,z,y,r,mat) in enumerate([(-13.5,23,21.3,1.45,'apple'),(-11,22.5,21.4,1.6,'orange'),(-12,25,21.4,1.5,'pear'),(-12.2,23.8,23.3,1.25,'apple')]):
        sphere(f'fruit-{i}',(x,y,z),r,M[mat]);cylinder(f'fruit-stem-{i}',(x,y+r,z),.12,.6,M['walnut-dark'],8)
    # Stack of chunky books + desk lamp create a readable distant landmark.
    for i,mat in enumerate(('teal','ivory','coral')):box(f'recipe-book-{i}',(17,19.3+i*.70,29),(12,.65,8),M[mat],.14)
    cylinder('lamp-base',(20,19.2,16),2.7,.5,M['brass'])
    cylinder('lamp-stem',(20,24,16),.30,9.4,M['brass'])
    bpy.ops.mesh.primitive_cone_add(vertices=32,radius1=4.0,radius2=2.0,depth=4.2,location=bp((20,29.4,16)))
    shade=bpy.context.object;shade.name='lamp-cream-shade';shade.parent=ROOM;shade.data.materials.append(M['cream'])
    cylinder('lamp-glow',(20,27.28,16),3.7,.12,M['warm-glow'])
    # Skirting portraits and original framed colour blocks.
    box('wall-art-frame',(23,22,42.9),(17,13,.5),M['walnut-dark'],.2)
    box('wall-art-paper',(23,22,42.58),(15.8,11.8,.12),M['cream'])
    art=Boxes('wall-art-abstract-blocks',[M['coral'],M['teal'],M['yellow']])
    art.add((20,23,42.48),(5.5,7,.08),0);art.add((26,20.5,42.45),(5.5,5,.10),1);art.add((25,25,42.46),(4.5,3,.10),2);art.finish()
    # Original toy packaging inside far west loop, clear of all lanes.
    box('toy-track-box',(-30,3.2,-2),(14,6.4,11),M['teal'],.3)
    box('toy-track-box-lid',(-30,6.5,-2),(14.4,.5,11.4),M['ivory'],.12)
    box('toy-track-box-label',(-30,3.7,-7.58),(9,2.8,.08),M['cream'])

def start_gantry():
    p,r,n,d=frame(0)
    # Checker stripe is flush over the first straight. Mesh is authoritative on surface.
    v=[];f=[];mi=[]
    for row in range(2):
        for col in range(12):
            base=len(v)
            for along,across in [(row*.32,col*WIDTH/12-WIDTH/2),(row*.32,(col+1)*WIDTH/12-WIDTH/2),((row+1)*.32,(col+1)*WIDTH/12-WIDTH/2),((row+1)*.32,col*WIDTH/12-WIDTH/2)]:
                v.append(bp(p+d*along+r*across+n*.025))
            f.append(tuple(range(base,base+4)));mi.append((row+col)%2)
    mesh('start-finish-checker',v,f,[M['slot'],M['ivory']],mi)
    # The start straight heads +X: local spans across Z, pillars outside all lanes.
    posts=Boxes('start-gantry-frame',[M['blue'],M['ivory']])
    for side in (-1,1):
        q=p+r*side*3.65;posts.add((q.x,2.8,q.z),(.5,5.6,.5));posts.add((q.x,.3,q.z),(1.1,.6,1.1),1)
    posts.add((p.x,5.5,p.z),(.65,.85,7.9));posts.finish(.10)
    box('start-gantry-sign',(p.x-.4,5.5,p.z),(.15,.65,4.6),M['ivory'],.04)
    for i in range(3):
        q=p+r*((i-1)*1.15);light=sphere(f'start-light-{i}',(q.x-.55,5.5,q.z),.30,M[f'light-{i}'])


def validation():
    objects=[o for o in bpy.context.scene.objects if o.type=='MESH']
    triangles=0;missing=[];bad=[]
    for o in objects:
        o.data.calc_loop_triangles();triangles+=len(o.data.loop_triangles)
        if not o.data.materials:missing.append(o.name)
        if any(abs(s-1)>1e-5 for s in o.scale):bad.append(o.name)
        if any(not math.isfinite(c) for v in o.data.vertices for c in v.co):raise RuntimeError('nonfinite '+o.name)
    if missing or bad:raise RuntimeError(f'Invalid meshes materials={missing}, transforms={bad}')
    if triangles>200000:raise RuntimeError(f'Triangle budget exceeded: {triangles}')
    samples=[frame(LENGTH*i/2048)[0] for i in range(2048)]
    radius=[]
    for i,b in enumerate(samples):
        a,c=samples[i-1],samples[(i+1)%len(samples)];area=(b-a).cross(c-a).length
        radius.append((b-a).length*(c-b).length*(c-a).length/(2*area) if area>1e-9 else 1e9)
    # Nonadjacent segments exclude a 16-unit geodesic neighbourhood on a smooth curve.
    separation=float('inf')
    for i in range(0,len(samples),4):
        for j in range(i+4,len(samples),4):
            arc=min(j-i,len(samples)-(j-i))*LENGTH/len(samples)*WORLD_PER_PROGRESS
            if arc<16:continue
            separation=min(separation,(samples[i]-samples[j]).length)
    if min(radius)<8:raise RuntimeError(f'Bend radius too tight {min(radius)}')
    if separation<WIDTH+1.2:raise RuntimeError(f'Road envelope overlaps {separation}')
    # Conservative scenery AABB test over swept road width plus20cm shoulder and1.4m carheadroom.
    # Floor intentionally sits below road; bridge supports andgantry belongto trackconstruction.
    collisions=[]
    for obj in HOUSEHOLD_MESHES:
        if obj.name.startswith(('oak-floor','floor-')):continue
        if obj.name in BOX_PROXIES:
            bounds=BOX_PROXIES[obj.name]
        else:
            coords=[obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
            game=[Vector((c.x,c.z,-c.y)) for c in coords]
            lo=Vector(tuple(min(c[k] for c in game) for k in range(3)))
            hi=Vector(tuple(max(c[k] for c in game) for k in range(3)))
            bounds=[(lo,hi)]
        for lo,hi in bounds:
            for i in range(1024):
                center,lateral,_,_=frame(LENGTH*i/1024)
                if hi.y<center.y-.7 or lo.y>center.y+2:continue
                if center.x<lo.x-4 or center.x>hi.x+4 or center.z<lo.z-4 or center.z>hi.z+4:continue
                for q in range(17):
                    point=center+lateral*((q/16*2-1)*(WIDTH/2+.20))
                    if lo.x-.15<=point.x<=hi.x+.15 and lo.z-.15<=point.z<=hi.z+.15 and hi.y>=point.y-.10 and lo.y<=point.y+1.4:
                        collisions.append(obj.name);break
                if obj.name in collisions:break
            if obj.name in collisions:break
    if collisions:raise RuntimeError('Scenery blocks swept road envelope: '+str(collisions))
    # Mesh is sampled every0.243worldunits; Catmull centre reconstruction at rowpointsexact.
    return {'triangles':triangles,'meshObjects':len(objects),'materials':len(bpy.data.materials),
      'minBendRadius':round(min(radius),5),'minimumNonadjacentCenterlineSeparation':round(separation,5),
      'nonadjacentArcExclusion':16,'roadEnvelopeWidth':WIDTH,'envelopeMargin':1.2,
      'centerlineWorldLength':round(LENGTH*WORLD_PER_PROGRESS,6),'trackProgressLength':LENGTH,
      'worldUnitsPerProgress':WORLD_PER_PROGRESS,'routeSamples':2048,'meshSamples':SEGMENTS,
      'bounds':{k:[round(min(p[i] for p in samples),4),round(max(p[i] for p in samples),4)] for i,k in enumerate(('x','y','z'))},
      'missingMaterials':missing,'unappliedScales':bad,'sceneryEnvelopeCollisions':collisions,'sceneryClearanceSamples':1024,'sceneryCarHeightAllowance':1.4,'laneFormula':'legacy horizontal tangent + vertical bank, exact runtime formula',
      'notes':['No crossings or jump gaps; east rise peaks at 6.41 world units.',
       'Table underside at 17.1; north straight surface at 0.65–3, with eastern entrance reaching 6.',
       'Gameplay obstacle list is empty; scenery bounds checked against 1,024 road cross sections, 17 width samples and 1.4 units of car headroom.']}

def look(obj,target):obj.rotation_euler=(bp(target)-obj.location).to_track_quat('-Z','Y').to_euler()

def render_outputs():
    bpy.context.preferences.filepaths.save_version=0
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.render.film_transparent=True
    scene.world=bpy.data.worlds.new('dining-world');scene.world.use_nodes=True
    bg=scene.world.node_tree.nodes.get('Background');bg.inputs['Color'].default_value=(.45,.57,.65,1);bg.inputs['Strength'].default_value=.45
    scene.view_settings.view_transform='AgX'
    for name,pos,energy,size,color in [('warm-key',(-25,65,-35),120000,65,(1,.82,.65)),('window-fill',(-15,40,42),100000,35,(.62,.78,1)),('east-rim',(58,35,12),60000,35,(1,.93,.78))]:
        data=bpy.data.lights.new(name,'AREA');data.energy=energy;data.shape='DISK';data.size=size;data.color=color
        o=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(o);o.location=bp(pos);look(o,(0,0,0))
    camdata=bpy.data.cameras.new('dining-overview-camera');camdata.type='ORTHO';camdata.ortho_scale=174
    camera=bpy.data.objects.new('dining-overview-camera',camdata);bpy.context.collection.objects.link(camera)
    camera.location=bp((92,88,-114));look(camera,(0,12,3));scene.camera=camera
    scene.render.resolution_x=1600;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
    scene.render.filepath=str(OVERVIEW_PATH);bpy.ops.render.render(write_still=True)
    camera.location=bp((110,115,-145));look(camera,(0,7,3));camdata.ortho_scale=175
    scene.render.resolution_x=512;scene.render.resolution_y=512;scene.render.filepath=str(CARD_PATH)
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))


def main():
    global ROOM,M,HOUSEHOLD_MESHES
    for directory in (GLB_PATH.parent,BLEND_PATH.parent,CARD_PATH.parent,REPORT_PATH.parent):directory.mkdir(parents=True,exist_ok=True)
    # Validate route schema in runtime tests; deterministic atomic write keeps editors safe.
    temporary=JSON_PATH.with_suffix('.json.tmp');temporary.write_text(json.dumps(ROUTE,indent=2)+'\n');os.replace(temporary,JSON_PATH)
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    ROOM=bpy.data.objects.new('dining-room',None);bpy.context.collection.objects.link(ROOM)
    colors={'asphalt':(.048,.063,.075),'slot':(.012,.018,.022),'blue':(.045,.24,.43),'edge':(.10,.45,.65),
      'copper':(.72,.42,.18),'ivory':(.86,.89,.79),'coral':(.80,.20,.11),'yellow':(.98,.68,.08),
      'oak-a':(.49,.30,.16),'oak-b':(.55,.35,.20),'oak-c':(.60,.39,.23),'oak-dark':(.23,.12,.065),
      'walnut':(.37,.19,.10),'walnut-dark':(.23,.105,.054),'sage':(.39,.53,.46),
      'sky':(.37,.63,.76),'cloth':(.69,.25,.15),'cream':(.95,.79,.53),'teal':(.075,.37,.37),
      'ceramic':(.75,.86,.82),'apple':(.74,.075,.04),'orange':(.98,.39,.035),'pear':(.55,.68,.12),
      'brass':(.72,.51,.19),'warm-glow':(1,.72,.35)}
    M={k:material('dining-'+k,v,rough=.38 if k in ('blue','edge','ceramic','apple','orange','pear') else .76,metal=.72 if k in ('copper','brass') else 0,emission=.45 if k=='sky' else 1.4 if k=='warm-glow' else 0) for k,v in colors.items()}
    for i in range(3):M[f'light-{i}']=material(f'start-light-material-{i}',(.20,.025,.018),rough=.35,emission=.3)
    road();before=set(bpy.context.scene.objects);household();HOUSEHOLD_MESHES=[o for o in bpy.context.scene.objects if o not in before and o.type=='MESH'];start_gantry();bpy.context.view_layer.update();report=validation()
    # Clear selectionsleftbyoperators; export exactlythecompleteassetroot, excludingrenderhelpers.
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.context.scene.objects:
        if o==ROOM or o.parent==ROOM:o.select_set(True)
    temporary=GLB_PATH.with_name('dining-table-run.build.glb')
    bpy.ops.export_scene.gltf(filepath=str(temporary),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_cameras=False,export_lights=False)
    if not temporary.exists() or temporary.stat().st_size<10000:raise RuntimeError('GLB export missing')
    os.replace(temporary,GLB_PATH)
    render_outputs()
    for path in (JSON_PATH,GLB_PATH,BLEND_PATH,CARD_PATH):
        if not path.exists() or path.stat().st_size==0:raise RuntimeError('Missing '+str(path))
    report.update({'assetId':ROUTE['id'],'version':ROUTE['version'],'sourceAxes':'Blender X=gameX,Y=-gameZ,Z=gameY','roadSurfaceNode':'track-surface','rootNode':'dining-room',
      'startLights':[f'start-light-{i}' for i in range(3)],'routeSha256':hashlib.sha256(JSON_PATH.read_bytes()).hexdigest(),
      'outputs':{str(p.relative_to(ROOT)):p.stat().st_size for p in (JSON_PATH,GLB_PATH,BLEND_PATH,CARD_PATH,OVERVIEW_PATH)}})
    REPORT_PATH.write_text(json.dumps(report,indent=2)+'\n')
    print('DINING_BUILD_OK '+json.dumps(report))

if __name__=='__main__':main()
