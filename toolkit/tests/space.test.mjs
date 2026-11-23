import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {loadProject} from '../cli/project.mjs';import {prepareModel,resolveLevels,validateModel,furnitureHeight} from '../space/model.mjs';
const example=fileURLToPath(new URL('../examples/two-level/project.json',import.meta.url));
test('Different origin, negative datum and local ceiling; slab relations recompute',()=>{const {data,report}=loadProject(example);assert(report.passed);const a=resolveLevels(data),b=resolveLevels(data,250);assert.deepEqual(a.levels.map(l=>l.elevation),[-400,2880]);assert.deepEqual(b.levels.map(l=>l.elevation),[-400,2950]);assert.equal(furnitureHeight(data,data.floors[1],data.floors[1].furniture[0],b),2700);assert.deepEqual(data.view.centerMm,[16000,-5000]);});
test('Missing height is rejected, not invented; zero datum is valid',()=>{const {data}=loadProject(example);data.floors[0].clearHeight=null;assert(!validateModel(data).passed);data.floors[0].clearHeight=3100;data.floors[0].elevation=0;assert(validateModel(data).passed)});
test('Cycles and missing references fail with useful report',()=>{const {data}=loadProject(example);data.floors[0].elevation={floorId:'upper'};assert(!validateModel(data).passed);data.floors[0].elevation={floorId:'nonexistent'};assert(!validateModel(data).passed)});
test('Empty furniture/openings and a single floor are supported',()=>{const {data}=loadProject(example);data.floors=[data.floors[0]];data.floors[0].ceilingFromFloorIds=[];data.floors[0].furniture=[];data.floors[0].doors=[];assert(validateModel(data).passed)});


test('Missing upper-floor reference produces a report instead of a crash',()=>{const {data}=loadProject(example);data.floors[0].ceilingFromFloorIds=['missing'];assert.equal(validateModel(data).passed,false)});
test('Omitted polygon holes are normalized before rendering',()=>{const {data}=loadProject(example);delete data.floors[0].slab[0].holes;assert.deepEqual(prepareModel(data).floors[0].slab[0].holes,[])});

test('Missing local-ceiling reference is reported',()=>{const {data}=loadProject(example);data.floors[1].ceilingZones[0].top={floorId:'missing'};assert.equal(validateModel(data).passed,false)});
