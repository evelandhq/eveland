import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InviteMemberForm } from "@/components/invite-member-form";
import { InvitationActions } from "@/components/invitation-actions";
import { MemberActions } from "@/components/member-actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getCurrentMember, getInvitations, getMembers } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function MembersSettingsPage() {
  const current = await getCurrentMember();
  const [members, invitations] = await Promise.all([
    getMembers(),
    current.role === "admin" ? getInvitations() : Promise.resolve([]),
  ]);
  const adminCount = members.filter((member) => member.role === "admin").length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">Members</h2>
        <p className="text-sm text-muted-foreground">Manage access to this Eveland workspace and its projects.</p>
      </header>

      {current.role === "admin" ? (
        <Card>
          <CardHeader>
            <CardTitle>Invite a member</CardTitle>
            <CardDescription>Create a single-use invitation link. Email delivery can be added later.</CardDescription>
          </CardHeader>
          <CardContent>
            <InviteMemberForm />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
          <CardDescription>{members.length} active {members.length === 1 ? "member" : "members"}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                {current.role === "admin" ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.userId}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{member.name ?? member.email}</span>
                      <span className="text-xs text-muted-foreground">{member.email}</span>
                    </div>
                  </TableCell>
                  <TableCell><Badge variant={member.role === "admin" ? "default" : "secondary"}>{member.role}</Badge></TableCell>
                  <TableCell>{new Date(member.joinedAt).toLocaleDateString()}</TableCell>
                  {current.role === "admin" ? (
                    <TableCell className="text-right">
                      <MemberActions member={member} isLastAdmin={member.role === "admin" && adminCount === 1} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {current.role === "admin" && invitations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
            <CardDescription>Refresh an invitation to rotate its link and extend it for seven days.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>{invitation.email}</TableCell>
                    <TableCell>{new Date(invitation.expiresAt).toLocaleString()}</TableCell>
                    <TableCell className="text-right"><InvitationActions invitationId={invitation.id} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
