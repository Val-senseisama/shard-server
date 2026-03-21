import { Schema, model, Document } from "mongoose";

export interface ErrorLogDocument extends Document {
  task?: string;
  errorMessage: string;
  timestamp: string;
  createdAt: Date;
}

const ErrorLogSchema = new Schema<ErrorLogDocument>(
  {
    task: String,
    errorMessage: { type: String, required: true },
    timestamp: { type: String, required: true },
  },
  { timestamps: true }
);

export default model<ErrorLogDocument>("ErrorLog", ErrorLogSchema);

