import {
  Box,
  Check,
  ClipboardCheck,
  Eye,
  History,
  Play,
  RotateCcw,
  RotateCw,
  Save,
  SplitSquareVertical,
  Undo2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSession } from "../api/client";
import { API } from "../api/client";
import type { CadDocument, FeatureOperation, GeometryResult, InterviewSession, ToolMode } from "../cad/model";
import { cloneDocument, newId, touchDocument } from "../cad/model";
import { SketchCanvas } from "./SketchCanvas";
import { Viewport3D } from "./Viewport3D";

export interface CadInterviewPanelProps {
  role: "candidate" | "interviewer";
  user: AppSession;
  session: InterviewSession;
  authToken: string;
  document: CadDocument;
  readOnly?: boolean;
  onDocumentChange: (document: CadDocument, detail: string) => void;
  onSessionChange: (session: InterviewSession) => void;
}

const EMPTY_GEOMETRY: GeometryResult = {
  bodies: [],
  parameters: {},
  warnings: [],
  featureCount: 0,
  constraintCount: 0
};

export function CadInterviewPanel({
  role,
  user,
  session,
  authToken,
  document,
  readOnly,
  onDocumentChange,
  onSessionChange
}: CadInterviewPanelProps) {
  const [tool, setTool] = useState<ToolMode>("select");
  const [operation, setOperation] = useState<FeatureOperation>("new");
  const [geometry, setGeometry] = useState<GeometryResult>(EMPTY_GEOMETRY);
  const [status, setStatus] = useState("Ready");
  const [past, setPast] = useState<CadDocument[]>([]);
  const [future, setFuture] = useState<CadDocument[]>([]);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("../cad/geometryWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: string; result: GeometryResult }>) => {
      setGeometry(event.data.result);
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  useEffect(() => {
    workerRef.current?.postMessage({ id: newId("solve"), document });
  }, [document]);

  const selectedEntity = useMemo(
    () => document.sketch.entities.find((entity) => entity.id === document.selectedEntityId),
    [document]
  );

  const commit = (next: CadDocument, detail: string) => {
    if (readOnly) return;
    setPast((items) => [...items.slice(-30), cloneDocument(document)]);
    setFuture([]);
    onDocumentChange(touchDocument(next), detail);
    setStatus(detail);
  };

  const addFeature = (type: "extrude" | "revolve") => {
    if (!selectedEntity || readOnly) {
      setStatus("Select sketch geometry first");
      return;
    }
    const next = cloneDocument(document);
    next.features.push({
      id: newId("feat"),
      type,
      entityId: selectedEntity.id,
      operation,
      distanceParam: "depth",
      angleParam: "revolveAngle",
      createdAt: new Date().toISOString()
    });
    commit(next, `${type === "extrude" ? "Extrude" : "Revolve"} feature added`);
  };

  const updateParameter = (name: string, expression: string) => {
    const next = cloneDocument(document);
    next.parameters[name] = { ...next.parameters[name], expression };
    commit(next, `Updated ${name}`);
  };

  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous || readOnly) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [cloneDocument(document), ...items]);
    onDocumentChange(previous, "Undo");
    setStatus("Undo");
  };

  const redo = () => {
    const next = future[0];
    if (!next || readOnly) return;
    setFuture((items) => items.slice(1));
    setPast((items) => [...items, cloneDocument(document)]);
    onDocumentChange(next, "Redo");
    setStatus("Redo");
  };

  const submit = async () => {
    const result = await API.submit(authToken, session.id, document);
    onSessionChange(result.session);
    setStatus("Submitted");
  };

  const saveNow = async () => {
    const result = await API.saveDocument(authToken, session.id, document);
    onSessionChange(result.session);
    setStatus("Saved");
  };

  return (
    <article className={role === "candidate" ? "cad-panel" : "cad-panel observer"}>
      <header className="panel-header">
        <div>
          <p className="eyebrow">{role === "candidate" ? "Candidate" : "Interviewer"}</p>
          <h2>{document.name}</h2>
        </div>
        <div className="panel-header-actions">
          <span className="status-pill">{session.status}</span>
          {role === "interviewer" && (
            <span className="status-pill muted">
              <Eye size={14} /> Observe
            </span>
          )}
        </div>
      </header>

      <div className="cad-layout">
        <div className="cad-primary">
          <SketchCanvas
            document={document}
            readOnly={readOnly}
            activeTool={tool}
            onToolChange={setTool}
            onChange={commit}
          />
          <section className="tool-surface viewport-surface">
            <div className="section-title">
              <Box size={18} />
              <span>Model</span>
            </div>
            <Viewport3D bodies={geometry.bodies} />
          </section>
        </div>

        <aside className="cad-sidebar">
          <section className="tool-surface compact">
            <div className="section-title">
              <SplitSquareVertical size={18} />
              <span>Features</span>
            </div>
            <div className="segmented">
              {(["new", "add", "cut"] as FeatureOperation[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={operation === value ? "active" : ""}
                  disabled={readOnly}
                  onClick={() => setOperation(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="action-grid">
              <button type="button" className="command-button" disabled={readOnly} onClick={() => addFeature("extrude")}>
                <Box size={17} /> Extrude
              </button>
              <button type="button" className="command-button" disabled={readOnly} onClick={() => addFeature("revolve")}>
                <RotateCw size={17} /> Revolve
              </button>
            </div>
            <ol className="feature-list">
              {document.features.map((feature, index) => (
                <li key={feature.id}>
                  <span>{index + 1}</span>
                  <strong>{feature.type}</strong>
                  <em>{feature.operation}</em>
                </li>
              ))}
            </ol>
          </section>

          <section className="tool-surface compact">
            <div className="section-title">
              <History size={18} />
              <span>Parameters</span>
            </div>
            <div className="parameter-list">
              {Object.values(document.parameters).map((parameter) => (
                <label key={parameter.name}>
                  <span>{parameter.name}</span>
                  <input
                    value={parameter.expression}
                    disabled={readOnly}
                    onChange={(event) => updateParameter(parameter.name, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="tool-surface compact">
            <div className="section-title">
              <ClipboardCheck size={18} />
              <span>Checks</span>
            </div>
            <div className="metric-grid">
              <Metric label="Features" value={geometry.featureCount} />
              <Metric label="Constraints" value={geometry.constraintCount} />
              <Metric label="Bodies" value={geometry.bodies.length} />
            </div>
            <div className="warning-list">
              {geometry.warnings.length === 0 ? (
                <p>
                  <Check size={15} /> Solved
                </p>
              ) : (
                geometry.warnings.map((warning) => <p key={warning}>{warning}</p>)
              )}
            </div>
          </section>
        </aside>
      </div>

      <footer className="panel-footer">
        <div className="footer-status">
          <span>{user.name}</span>
          <span>{status}</span>
        </div>
        <div className="footer-actions">
          <button type="button" className="icon-button" title="Undo" aria-label="Undo" disabled={readOnly || !past.length} onClick={undo}>
            <Undo2 size={18} />
          </button>
          <button type="button" className="icon-button" title="Redo" aria-label="Redo" disabled={readOnly || !future.length} onClick={redo}>
            <RotateCcw size={18} />
          </button>
          <button type="button" className="command-button" disabled={readOnly} onClick={saveNow}>
            <Save size={17} /> Save
          </button>
          {role === "candidate" && (
            <button type="button" className="command-button primary" onClick={submit}>
              <Play size={17} /> Submit
            </button>
          )}
        </div>
      </footer>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
