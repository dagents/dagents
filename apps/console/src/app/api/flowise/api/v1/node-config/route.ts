import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    await request.json()
    return NextResponse.json([])
  } catch {
    return NextResponse.json([])
  }
}
