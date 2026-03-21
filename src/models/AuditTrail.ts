import { Schema, model, Types, Document } from "mongoose";

export interface AuditTrailDocument extends Document {
  userId: Types.ObjectId;
  task: string;
  details: string;
  createdAt: Date;
}

const AuditTrailSchema = new Schema<AuditTrailDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    task: { type: String, required: true },
    details: { type: String, required: true },
  },
  { timestamps: true }
);

export default model<AuditTrailDocument>("AuditTrail", AuditTrailSchema);

