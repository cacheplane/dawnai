import { NextResponse } from "next/server"
import { loadBlueprints } from "../../../lib/blueprints"

export function GET() {
  return NextResponse.json(loadBlueprints().map((entry) => entry.meta))
}
