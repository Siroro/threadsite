import RAPIER from "@dimforge/rapier3d-compat";
import { DT, RAMP_INDICES, RAMP_VERTICES, type Engine, type Vec3 } from "./shared.js";

export async function load(): Promise<Engine> {
  await RAPIER.init();
  return { create(sleep) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = DT;
    world.numSolverIterations = 4;
    const events = new RAPIER.EventQueue(true);
    const bodies = new Map<number, RAPIER.RigidBody>();
    const sensors = new Set<number>();
    const vector = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    let nextId = 0;
    return {
      add(spec) {
        const desc = spec.type === "fixed" ? RAPIER.RigidBodyDesc.fixed() : spec.type === "kinematic" ? RAPIER.RigidBodyDesc.kinematicVelocityBased() : RAPIER.RigidBodyDesc.dynamic();
        desc.setTranslation(...spec.position).setCanSleep(sleep).setLinearDamping(0).setAngularDamping(0);
        if (spec.actor) desc.lockRotations();
        if (spec.bullet) desc.setCcdEnabled(true).setGravityScale(0);
        if (spec.velocity) desc.setLinvel(...spec.velocity);
        const body = world.createRigidBody(desc);
        const shape = spec.shape === "sphere" ? RAPIER.ColliderDesc.ball(spec.size[0]) : spec.shape === "capsule" ? RAPIER.ColliderDesc.capsule(spec.size[1], spec.size[0]) : spec.shape === "mesh" ? RAPIER.ColliderDesc.trimesh(RAMP_VERTICES, RAMP_INDICES) : RAPIER.ColliderDesc.cuboid(...spec.size);
        shape.setDensity(1).setFriction(0.5).setRestitution(0).setSensor(!!spec.sensor);
        if (spec.sensor) shape.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        const collider = world.createCollider(shape, body);
        if (spec.sensor) sensors.add(collider.handle);
        const id = nextId++; bodies.set(id, body); return id;
      },
      remove(id) { const body = bodies.get(id)!; world.removeRigidBody(body); bodies.delete(id); },
      move(id, p) { bodies.get(id)!.setTranslation(vector(p), true); },
      velocity(id, v) { bodies.get(id)!.setLinvel(vector(v), true); },
      read(id, out) {
        const body = bodies.get(id)!, p = body.translation(), q = body.rotation();
        out.position[0] = p.x; out.position[1] = p.y; out.position[2] = p.z;
        out.rotation[0] = q.x; out.rotation[1] = q.y; out.rotation[2] = q.z; out.rotation[3] = q.w;
      },
      awake(id) { return !bodies.get(id)!.isSleeping(); },
      ray(origin, translation) {
        Object.assign(ray.origin, vector(origin)); Object.assign(ray.dir, vector(translation));
        return world.castRay(ray, 1, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS) !== null;
      },
      events() {
        let begin = 0, end = 0;
        events.drainCollisionEvents((a, b, started) => { if (sensors.has(a) || sensors.has(b)) { if (started) begin++; else end++; } });
        return { begin, end };
      },
      step() { world.step(events); },
      destroy() { events.free(); world.free(); bodies.clear(); },
    };
  } };
}
