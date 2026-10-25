import { PageHeader } from "@/components/shell/page-header";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PageHeader title={`Project ${id}`} />
      <main className="p-4 text-sm text-muted-foreground">This screen is being built.</main>
    </>
  );
}
