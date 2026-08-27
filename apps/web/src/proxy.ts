import { NextResponse, type NextRequest } from "next/server";

const publicPaths = new Set(["/login", "/accept-invite", "/reset-password"]);

export function proxy(request: NextRequest) {
  const isPublic = publicPaths.has(request.nextUrl.pathname);
  // Better Auth prefixes the cookie with `__Secure-` when useSecureCookies is on
  // (an https baseURL), so the deployed cookie is `__Secure-eveland_session`.
  const hasSession =
    request.cookies.has("eveland_session") || request.cookies.has("__Secure-eveland_session");
  if (!isPublic && !hasSession) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
