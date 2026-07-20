import { redirect } from "next/navigation";

export const metadata = {
  title: "New project",
};

export default function NewProjectPage() {
  redirect("/new");
}
