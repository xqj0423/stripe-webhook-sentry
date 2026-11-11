// Bad webhook implementation to test scanner
import { NextRequest, NextResponse } from "next/server";

const webhookSecret = "whsec_abcdef1234567890abcdef123456"; // LEAK!

export async function POST(req: NextRequest) {
  // Bug: used json() instead of text()!
  const body = await req.json();
  
  // Bug: no constructEvent or signature verification!
  if (body.type === 'checkout.session.completed') {
    // Missing idempotency!
    console.log("paid!");
  }
  
  return NextResponse.json({ ok: true });
}
