import { Skeleton } from "@/components/ui/feedback";

export default function AdminLoading() {
  return (
    <div className="min-h-svh bg-background p-4 sm:p-8 lg:ml-[15.5rem]">
      <div className="mx-auto max-w-[92rem]">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="mt-4 h-9 w-64" />
        <Skeleton className="mt-3 h-5 w-full max-w-xl" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton className="h-36" key={index} />
          ))}
        </div>
        <Skeleton className="mt-7 h-80 w-full" />
      </div>
    </div>
  );
}
