import { Circle, MousePointer2, Ruler, Slash, Square, Link2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { CadDocument, SketchEntity, ToolMode } from "../cad/model";
import { newId, touchDocument } from "../cad/model";

interface SketchCanvasProps {
  document: CadDocument;
  readOnly?: boolean;
  activeTool: ToolMode;
  onToolChange: (tool: ToolMode) => void;
  onChange: (document: CadDocument, detail: string) => void;
}

interface Point {
  x: number;
  y: number;
}

type GridLine = { axis: "x"; value: number } | { axis: "y"; value: number };

const TOOLS: Array<{ id: ToolMode; label: string; icon: typeof MousePointer2 }> = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "line", label: "Line", icon: Slash },
  { id: "rectangle", label: "Rectangle", icon: Square },
  { id: "circle", label: "Circle", icon: Circle },
  { id: "dimension", label: "Dimension", icon: Ruler },
  { id: "constraint", label: "Constraint", icon: Link2 }
];

function screenPoint(event: React.PointerEvent<SVGSVGElement>): Point {
  const svg = event.currentTarget;
  const rect = svg.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 240 - 120;
  const y = ((event.clientY - rect.top) / rect.height) * 180 - 90;
  return { x: Math.round(x), y: Math.round(y) };
}

function distanceToEntity(point: Point, entity: SketchEntity) {
  if (entity.type === "circle") {
    return Math.abs(Math.hypot(point.x - entity.cx, point.y - entity.cy) - entity.radius);
  }
  if (entity.type === "rectangle") {
    const minX = Math.min(entity.x, entity.x + entity.width);
    const maxX = Math.max(entity.x, entity.x + entity.width);
    const minY = Math.min(entity.y, entity.y + entity.height);
    const maxY = Math.max(entity.y, entity.y + entity.height);
    const dx = Math.max(minX - point.x, 0, point.x - maxX);
    const dy = Math.max(minY - point.y, 0, point.y - maxY);
    const edge = Math.min(Math.abs(point.x - minX), Math.abs(point.x - maxX), Math.abs(point.y - minY), Math.abs(point.y - maxY));
    return dx || dy ? Math.hypot(dx, dy) : edge;
  }
  const length = Math.hypot(entity.x2 - entity.x1, entity.y2 - entity.y1) || 1;
  return (
    Math.abs((entity.y2 - entity.y1) * point.x - (entity.x2 - entity.x1) * point.y + entity.x2 * entity.y1 - entity.y2 * entity.x1) /
    length
  );
}

function nearestEntity(point: Point, entities: SketchEntity[]) {
  const scored = entities.map((entity) => ({ entity, distance: distanceToEntity(point, entity) }));
  scored.sort((a, b) => a.distance - b.distance);
  return scored[0]?.distance < 8 ? scored[0].entity : null;
}

function parameterName(document: CadDocument, base: string) {
  let index = 1;
  let name = `${base}${index}`;
  while (document.parameters[name]) {
    index += 1;
    name = `${base}${index}`;
  }
  return name;
}

export function SketchCanvas({ document, readOnly, activeTool, onToolChange, onChange }: SketchCanvasProps) {
  const [draftStart, setDraftStart] = useState<Point | null>(null);
  const [draftEnd, setDraftEnd] = useState<Point | null>(null);

  const gridLines = useMemo(
    () =>
      (Array.from({ length: 25 }, (_, index) => -120 + index * 10).map((value) => ({ axis: "x", value })) as GridLine[]).concat(
        Array.from({ length: 19 }, (_, index) => -90 + index * 10).map((value) => ({ axis: "y", value }) as GridLine)
      ),
    []
  );

  const commitSelection = (point: Point) => {
    const entity = nearestEntity(point, document.sketch.entities);
    if (!entity) return;
    onChange(touchDocument({ ...document, selectedEntityId: entity.id }), `Selected ${entity.type}`);
  };

  const commitDimension = (point: Point) => {
    const entity = nearestEntity(point, document.sketch.entities);
    if (!entity) return;
    const next = structuredClone(document) as CadDocument;
    const target = next.sketch.entities.find((item) => item.id === entity.id);
    if (!target) return;
    if (target.type === "rectangle") {
      const widthName = target.widthParam || parameterName(next, "width");
      target.widthParam = widthName;
      next.parameters[widthName] = next.parameters[widthName] || {
        name: widthName,
        expression: `${Math.abs(target.width)} mm`,
        unit: "mm"
      };
      next.sketch.constraints.push({
        id: newId("con"),
        type: "dimension",
        entityIds: [target.id],
        parameter: widthName,
        label: `Dimension ${widthName}`
      });
    }
    if (target.type === "circle") {
      const radiusName = target.radiusParam || parameterName(next, "radius");
      target.radiusParam = radiusName;
      next.parameters[radiusName] = next.parameters[radiusName] || {
        name: radiusName,
        expression: `${Math.abs(target.radius)} mm`,
        unit: "mm"
      };
      next.sketch.constraints.push({
        id: newId("con"),
        type: "dimension",
        entityIds: [target.id],
        parameter: radiusName,
        label: `Dimension ${radiusName}`
      });
    }
    onChange(touchDocument({ ...next, selectedEntityId: target.id }), "Added driving dimension");
  };

  const commitConstraint = (point: Point) => {
    const entity = nearestEntity(point, document.sketch.entities);
    if (!entity) return;
    const next = structuredClone(document) as CadDocument;
    const target = next.sketch.entities.find((item) => item.id === entity.id);
    if (!target) return;
    const type = target.type === "line" ? "horizontal" : target.type === "circle" ? "tangent" : "vertical";
    if (!target.constraints.includes(type)) {
      target.constraints.push(type);
    }
    next.sketch.constraints.push({
      id: newId("con"),
      type,
      entityIds: [target.id],
      label: `${type} constraint`
    });
    onChange(touchDocument({ ...next, selectedEntityId: target.id }), `Added ${type} constraint`);
  };

  const commitDraft = (start: Point, end: Point) => {
    if (readOnly) return;
    const next = structuredClone(document) as CadDocument;
    let entity: SketchEntity | null = null;
    if (activeTool === "line") {
      entity = { id: newId("ent"), type: "line", x1: start.x, y1: start.y, x2: end.x, y2: end.y, constraints: [] };
    }
    if (activeTool === "rectangle") {
      const widthName = parameterName(next, "width");
      const heightName = parameterName(next, "height");
      entity = {
        id: newId("ent"),
        type: "rectangle",
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x) || 10,
        height: Math.abs(end.y - start.y) || 10,
        widthParam: widthName,
        heightParam: heightName,
        constraints: ["horizontal", "vertical"]
      };
      next.parameters[widthName] = { name: widthName, expression: `${entity.width} mm`, unit: "mm" };
      next.parameters[heightName] = { name: heightName, expression: `${entity.height} mm`, unit: "mm" };
    }
    if (activeTool === "circle") {
      const radiusName = parameterName(next, "radius");
      const radius = Math.max(5, Math.round(Math.hypot(end.x - start.x, end.y - start.y)));
      entity = {
        id: newId("ent"),
        type: "circle",
        cx: start.x,
        cy: start.y,
        radius,
        radiusParam: radiusName,
        constraints: []
      };
      next.parameters[radiusName] = { name: radiusName, expression: `${radius} mm`, unit: "mm" };
    }
    if (!entity) return;
    next.sketch.entities.push(entity);
    onChange(touchDocument({ ...next, selectedEntityId: entity.id }), `Added ${entity.type}`);
  };

  const pointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (readOnly) return;
    const point = screenPoint(event);
    if (activeTool === "select") {
      commitSelection(point);
      return;
    }
    if (activeTool === "dimension") {
      commitDimension(point);
      return;
    }
    if (activeTool === "constraint") {
      commitConstraint(point);
      return;
    }
    setDraftStart(point);
    setDraftEnd(point);
  };

  const pointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!draftStart) return;
    setDraftEnd(screenPoint(event));
  };

  const pointerUp = () => {
    if (draftStart && draftEnd) {
      commitDraft(draftStart, draftEnd);
    }
    setDraftStart(null);
    setDraftEnd(null);
  };

  return (
    <section className="tool-surface sketch-surface">
      <div className="icon-toolbar" aria-label="Sketch tools">
        {TOOLS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={activeTool === id ? "icon-button active" : "icon-button"}
            type="button"
            title={label}
            aria-label={label}
            disabled={readOnly}
            onClick={() => onToolChange(id)}
          >
            <Icon size={18} />
          </button>
        ))}
      </div>
      <svg
        className="sketch-canvas"
        viewBox="-120 -90 240 180"
        role="img"
        aria-label="Sketch canvas"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerLeave={pointerUp}
      >
        <rect x="-120" y="-90" width="240" height="180" className="sketch-bg" />
        {gridLines.map((line, index) =>
          line.axis === "x" ? (
            <line key={`x-${index}`} x1={line.value} x2={line.value} y1="-90" y2="90" className="grid-line" />
          ) : (
            <line key={`y-${index}`} x1="-120" x2="120" y1={line.value} y2={line.value} className="grid-line" />
          )
        )}
        <line x1="-120" x2="120" y1="0" y2="0" className="axis-line" />
        <line x1="0" x2="0" y1="-90" y2="90" className="axis-line" />
        {document.sketch.entities.map((entity) => (
          <SketchEntityView key={entity.id} entity={entity} selected={document.selectedEntityId === entity.id} />
        ))}
        {draftStart && draftEnd && activeTool === "line" && (
          <line x1={draftStart.x} y1={draftStart.y} x2={draftEnd.x} y2={draftEnd.y} className="draft-line" />
        )}
        {draftStart && draftEnd && activeTool === "rectangle" && (
          <rect
            x={Math.min(draftStart.x, draftEnd.x)}
            y={Math.min(draftStart.y, draftEnd.y)}
            width={Math.abs(draftEnd.x - draftStart.x)}
            height={Math.abs(draftEnd.y - draftStart.y)}
            className="draft-shape"
          />
        )}
        {draftStart && draftEnd && activeTool === "circle" && (
          <circle
            cx={draftStart.x}
            cy={draftStart.y}
            r={Math.max(1, Math.hypot(draftEnd.x - draftStart.x, draftEnd.y - draftStart.y))}
            className="draft-shape"
          />
        )}
      </svg>
    </section>
  );
}

function SketchEntityView({ entity, selected }: { entity: SketchEntity; selected: boolean }) {
  const className = selected ? "sketch-entity selected" : "sketch-entity";
  if (entity.type === "line") {
    return <line x1={entity.x1} y1={entity.y1} x2={entity.x2} y2={entity.y2} className={className} />;
  }
  if (entity.type === "rectangle") {
    return <rect x={entity.x} y={entity.y} width={entity.width} height={entity.height} className={className} />;
  }
  return <circle cx={entity.cx} cy={entity.cy} r={entity.radius} className={className} />;
}
