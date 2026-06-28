import type { CadDocument, GeometryResult, PreviewBody, SketchEntity } from "./model";
import { resolveParameters } from "./parametric";

const clampPositive = (value: number, fallback: number) =>
  Number.isFinite(value) && Math.abs(value) > 0.01 ? Math.abs(value) : fallback;

function entityDimensions(entity: SketchEntity, parameters: Record<string, number>) {
  if (entity.type === "rectangle") {
    const width = entity.widthParam ? parameters[entity.widthParam] : entity.width;
    const height = entity.heightParam ? parameters[entity.heightParam] : entity.height;
    return {
      ...entity,
      width: clampPositive(width, Math.abs(entity.width)),
      height: clampPositive(height, Math.abs(entity.height))
    };
  }
  if (entity.type === "circle") {
    const radius = entity.radiusParam ? parameters[entity.radiusParam] : entity.radius;
    return { ...entity, radius: clampPositive(radius, Math.abs(entity.radius)) };
  }
  return entity;
}

function buildGeometry(document: CadDocument): GeometryResult {
  const resolved = resolveParameters(document.parameters);
  const parameters = resolved.values;
  const warnings = [...resolved.warnings];
  const entities = new Map(document.sketch.entities.map((entity) => [entity.id, entity]));
  const bodies: PreviewBody[] = [];

  for (const feature of document.features) {
    const rawEntity = entities.get(feature.entityId);
    if (!rawEntity) {
      warnings.push(`Feature ${feature.id} references a missing sketch entity`);
      continue;
    }
    const entity = entityDimensions(rawEntity, parameters);
    const distance = clampPositive(
      feature.distanceParam ? parameters[feature.distanceParam] : parameters.depth,
      12
    );
    const label = `${feature.type} ${entity.type}`;

    if (feature.type === "extrude") {
      if (entity.type === "rectangle") {
        bodies.push({
          id: feature.id,
          kind: "box",
          label,
          width: entity.width,
          height: entity.height,
          depth: distance,
          operation: feature.operation
        });
      } else if (entity.type === "circle") {
        bodies.push({
          id: feature.id,
          kind: "cylinder",
          label,
          radius: entity.radius,
          height: distance,
          operation: feature.operation
        });
      } else {
        bodies.push({
          id: feature.id,
          kind: "cone",
          label,
          radiusTop: clampPositive(entity.x2, 4),
          radiusBottom: clampPositive(entity.x1, 8),
          height: clampPositive(entity.y2 - entity.y1, 20),
          operation: feature.operation
        });
      }
    }

    if (feature.type === "revolve") {
      if (entity.type === "rectangle") {
        const innerRadius = Math.max(0, Math.min(Math.abs(entity.x), Math.abs(entity.x + entity.width)));
        const outerRadius = Math.max(Math.abs(entity.x), Math.abs(entity.x + entity.width), entity.width / 2);
        bodies.push({
          id: feature.id,
          kind: innerRadius > 0.5 ? "tube" : "cylinder",
          label,
          innerRadius,
          outerRadius,
          radius: outerRadius,
          height: entity.height,
          operation: feature.operation
        } as PreviewBody);
      } else if (entity.type === "circle") {
        bodies.push({
          id: feature.id,
          kind: "torus",
          label,
          majorRadius: clampPositive(entity.cx, Math.max(entity.radius * 2.4, 12)),
          tubeRadius: entity.radius,
          operation: feature.operation
        });
      } else {
        bodies.push({
          id: feature.id,
          kind: "cone",
          label,
          radiusTop: clampPositive(entity.x2, 4),
          radiusBottom: clampPositive(entity.x1, 10),
          height: clampPositive(entity.y2 - entity.y1, 24),
          operation: feature.operation
        });
      }
    }
  }

  return {
    bodies,
    parameters,
    warnings,
    featureCount: document.features.length,
    constraintCount: document.sketch.constraints.length
  };
}

self.onmessage = (event: MessageEvent<{ id: string; document: CadDocument }>) => {
  try {
    const result = buildGeometry(event.data.document);
    self.postMessage({ id: event.data.id, result });
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      result: {
        bodies: [],
        parameters: {},
        warnings: [error instanceof Error ? error.message : "Geometry failed"],
        featureCount: 0,
        constraintCount: 0
      } satisfies GeometryResult
    });
  }
};
