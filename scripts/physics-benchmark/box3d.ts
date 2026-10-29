import Box3D, { type b3BodyId, type b3MeshData } from "box3d.js/inline";
import { DT, RAMP_INDICES, RAMP_VERTICES, type Engine } from "./shared.js";

export async function load(): Promise<Engine> {
  const b3 = await Box3D();
  return { create(sleep) {
    const def = b3.b3DefaultWorldDef(); def.gravity = [0, -9.81, 0]; def.enableSleep = sleep;
    const world = b3.b3CreateWorld(def);
    const bodies = new Map<number, b3BodyId>();
    const meshes: b3MeshData[] = [];
    const events = b3.createEventsBuffer();
    const filter = b3.b3DefaultQueryFilter();
    let nextId = 0;
    return {
      add(spec) {
        const bodyDef = b3.b3DefaultBodyDef();
        bodyDef.type = spec.type === "fixed" ? b3.b3BodyType.b3_staticBody : spec.type === "kinematic" ? b3.b3BodyType.b3_kinematicBody : b3.b3BodyType.b3_dynamicBody;
        bodyDef.position = spec.position; bodyDef.enableSleep = sleep;
        bodyDef.linearDamping = bodyDef.angularDamping = 0;
        if (spec.actor) bodyDef.motionLocks.angularX = bodyDef.motionLocks.angularY = bodyDef.motionLocks.angularZ = true;
        if (spec.bullet) { bodyDef.isBullet = true; bodyDef.gravityScale = 0; }
        if (spec.velocity) bodyDef.linearVelocity = spec.velocity;
        const body = b3.b3CreateBody(world, bodyDef);
        const shape = b3.b3DefaultShapeDef();
        shape.density = 1; shape.baseMaterial.friction = 0.5; shape.baseMaterial.restitution = 0;
        shape.isSensor = !!spec.sensor; shape.enableSensorEvents = true;
        shape.enableContactEvents = false;
        if (spec.shape === "sphere") b3.b3CreateSphereShape(body, shape, { center: [0, 0, 0], radius: spec.size[0] });
        else if (spec.shape === "capsule") b3.b3CreateCapsuleShape(body, shape, { center1: [0, -spec.size[1], 0], center2: [0, spec.size[1], 0], radius: spec.size[0] });
        else if (spec.shape === "mesh") {
          const mesh = b3.b3CreateMesh(RAMP_VERTICES, RAMP_INDICES);
          if (!mesh) throw new Error("Box3D mesh creation failed");
          meshes.push(mesh); b3.b3CreateMeshShape(body, shape, mesh, [1, 1, 1]);
        } else b3.b3CreateBoxShape(body, shape, ...spec.size);
        const id = nextId++; bodies.set(id, body); return id;
      },
      remove(id) { b3.b3DestroyBody(bodies.get(id)!); bodies.delete(id); },
      move(id, p) { b3.b3Body_SetTransform(bodies.get(id)!, p, [0, 0, 0, 1]); },
      velocity(id, v) { b3.b3Body_SetLinearVelocity(bodies.get(id)!, v); },
      read(id, out) { const body = bodies.get(id)!; b3.b3Body_GetPosition(out.position, body); b3.b3Body_GetRotation(out.rotation, body); },
      awake(id) { return b3.b3Body_IsAwake(bodies.get(id)!); },
      ray(origin, translation) { return b3.b3World_CastRayClosest(world, origin, translation, filter).hit; },
      events() {
        b3.getEvents(events, world);
        return { begin: b3.getNumSensorBeginEvents(events), end: b3.getNumSensorEndEvents(events) };
      },
      step() { b3.b3World_Step(world, DT, 4); },
      destroy() { b3.destroyEventsBuffer(events); b3.b3DestroyWorld(world); for (const mesh of meshes) b3.b3DestroyMesh(mesh); bodies.clear(); },
    };
  } };
}
