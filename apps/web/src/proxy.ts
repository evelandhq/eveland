import { NextResponse, type NextRequest } from "next/server";

const publicPaths = new Set(["/login", "/accept-invite"]);

export function proxy(request: NextRequest) {
  const isPublic = publicPaths.has(request.nextUrl.pathname);
  const hasSession = request.cookies.has("eveland_session");
  if (!isPublic && !hasSession) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
