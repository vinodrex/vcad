export type ToolMode = "select" | "line" | "rectangle" | "circle" | "dimension" | "constraint";
export type FeatureType = "extrude" | "revolve";
export type FeatureOperation = "new" | "add" | "cut";
export type ConstraintType = "horizontal" | "vertical" | "equal" | "parallel" | "perpendicular" | "tangent";

export interface ParameterValue {
  name: string;
  expression: string;
  unit: "mm" | "deg";
}

export interface SketchConstraint {
  id: string;
  type: ConstraintType | "dimension";
  entityIds: string[];
  parameter?: string;
  label: string;
}

export interface LineEntity {
  id: string;
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  constraints: string[];
}

export interface RectangleEntity {
  id: string;
  type: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
  widthParam?: string;
  heightParam?: string;
  constraints: string[];
}

export interface CircleEntity {
  id: string;
  type: "circle";
  cx: number;
  cy: number;
  radius: number;
  radiusParam?: string;
  constraints: string[];
}

export type SketchEntity = LineEntity | RectangleEntity | CircleEntity;

export interface Sketch {
  id: string;
  name: string;
  plane: "front";
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

export interface Feature {
  id: string;
  type: FeatureType;
  entityId: string;
  operation: FeatureOperation;
  distanceParam?: string;
  angleParam?: string;
  createdAt: string;
}

export interface CadDocument {
  id: string;
  name: string;
  parameters: Record<string, ParameterValue>;
  sketch: Sketch;
  features: Feature[];
  selectedEntityId?: string;
  updatedAt: string;
}

export interface InterviewTemplate {
  id: string;
  title: string;
  target: string;
  expectedParameters: string[];
  rubric: string[];
  starterDocument: CadDocument;
}

export interface InterviewSession {
  id: string;
  title: string;
  templateId: string;
  candidateName: string;
  interviewerName: string;
  status: "draft" | "active" | "submitted";
  createdAt: string;
  updatedAt: string;
  document: CadDocument;
  eventLog: InterviewEvent[];
  submission?: InterviewSubmission;
}

export interface InterviewEvent {
  id: string;
  type: string;
  actor: string;
  at: string;
  detail: string;
}

export interface InterviewSubmission {
  id: string;
  submittedAt: string;
  score: number;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  document: CadDocument;
}

export type PreviewBody =
  | {
      id: string;
      kind: "box";
      label: string;
      width: number;
      height: number;
      depth: number;
      operation: FeatureOperation;
    }
  | {
      id: string;
      kind: "cylinder";
      label: string;
      radius: number;
      height: number;
      operation: FeatureOperation;
    }
  | {
      id: string;
      kind: "tube";
      label: string;
      innerRadius: number;
      outerRadius: number;
      height: number;
      operation: FeatureOperation;
    }
  | {
      id: string;
      kind: "torus";
      label: string;
      majorRadius: number;
      tubeRadius: number;
      operation: FeatureOperation;
    }
  | {
      id: string;
      kind: "cone";
      label: string;
      radiusTop: number;
      radiusBottom: number;
      height: number;
      operation: FeatureOperation;
    };

export interface GeometryResult {
  bodies: PreviewBody[];
  parameters: Record<string, number>;
  warnings: string[];
  featureCount: number;
  constraintCount: number;
}

const now = () => new Date().toISOString();

export function newId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createStarterDocument(): CadDocument {
  const rectId = newId("ent");
  const holeId = newId("ent");
  const doc: CadDocument = {
    id: newId("doc"),
    name: "Mounting bracket",
    parameters: {
      width: { name: "width", expression: "72 mm", unit: "mm" },
      height: { name: "height", expression: "44 mm", unit: "mm" },
      depth: { name: "depth", expression: "18 mm", unit: "mm" },
      holeRadius: { name: "holeRadius", expression: "6 mm", unit: "mm" },
      revolveAngle: { name: "revolveAngle", expression: "360 deg", unit: "deg" }
    },
    sketch: {
      id: newId("sketch"),
      name: "Front profile",
      plane: "front",
      entities: [
        {
          id: rectId,
          type: "rectangle",
          x: -36,
          y: -22,
          width: 72,
          height: 44,
          widthParam: "width",
          heightParam: "height",
          constraints: ["horizontal", "vertical"]
        },
        {
          id: holeId,
          type: "circle",
          cx: 0,
          cy: 0,
          radius: 6,
          radiusParam: "holeRadius",
          constraints: ["tangent"]
        }
      ],
      constraints: [
        {
          id: newId("con"),
          type: "dimension",
          entityIds: [rectId],
          parameter: "width",
          label: "Driven width"
        },
        {
          id: newId("con"),
          type: "dimension",
          entityIds: [rectId],
          parameter: "height",
          label: "Driven height"
        },
        {
          id: newId("con"),
          type: "dimension",
          entityIds: [holeId],
          parameter: "holeRadius",
          label: "Driven hole radius"
        }
      ]
    },
    features: [
      {
        id: newId("feat"),
        type: "extrude",
        entityId: rectId,
        operation: "new",
        distanceParam: "depth",
        createdAt: now()
      },
      {
        id: newId("feat"),
        type: "extrude",
        entityId: holeId,
        operation: "cut",
        distanceParam: "depth",
        createdAt: now()
      }
    ],
    selectedEntityId: rectId,
    updatedAt: now()
  };
  return doc;
}

export function cloneDocument(document: CadDocument): CadDocument {
  return JSON.parse(JSON.stringify(document)) as CadDocument;
}

export function touchDocument(document: CadDocument): CadDocument {
  return { ...document, updatedAt: now() };
}
