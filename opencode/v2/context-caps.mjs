/** Apply host ceilings after OpenCode has resolved its full native model catalog. */
export function applyContextCaps(models, caps) {
  for (const model of models.list()) {
    const ref = `${model.providerID}/${model.id}`;
    const cap = caps[ref] ?? caps[model.providerID];
    if (!cap) continue;
    const context = model.limit.context > 0 ? Math.min(model.limit.context, cap) : cap;
    const input = model.limit.input === undefined ? undefined : Math.min(model.limit.input, context);
    models.update(model.providerID, model.id, (current) => {
      current.limit = { ...current.limit, context, ...(input === undefined ? {} : { input }) };
    });
  }
}
