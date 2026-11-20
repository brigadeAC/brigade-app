// Program items for one program, with optimistic create/update/delete.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";

export const programItemsKey = (programId) => ["programItems", programId];

const tempId = () => `tmp-${Math.random().toString(36).slice(2, 10)}`;

export function useProgramItems(programId) {
  const queryClient = useQueryClient();
  const key = programItemsKey(programId);

  const query = useQuery({
    queryKey: key,
    queryFn: () => base44.entities.ProgramItem.filter({ program_id: programId }),
    enabled: !!programId,
  });

  const snapshot = () => queryClient.getQueryData(key) || [];
  const setItems = (fn) => queryClient.setQueryData(key, (old = []) => fn(old));

  const fail = (prev, err, msg) => {
    queryClient.setQueryData(key, prev);
    toast.error(err?.message || msg);
  };

  const create = async (fields) => {
    const prev = snapshot();
    const tid = tempId();
    const data = { ...fields, program_id: programId };
    setItems((old) => [...old, { ...data, id: tid, _pending: true }]);
    try {
      const saved = await base44.entities.ProgramItem.create(data);
      setItems((old) => old.map((i) => (i.id === tid ? saved : i)));
      return saved;
    } catch (err) {
      fail(prev, err, "Couldn't add the item.");
      return null;
    }
  };

  const createMany = async (list) => {
    if (!list.length) return [];
    const prev = snapshot();
    const rows = list.map((f) => ({ ...f, program_id: programId }));
    const temps = rows.map((r) => ({ ...r, id: tempId(), _pending: true }));
    setItems((old) => [...old, ...temps]);
    try {
      const saved = await base44.entities.ProgramItem.bulkCreate(rows);
      const ids = new Set(temps.map((t) => t.id));
      setItems((old) => [...old.filter((i) => !ids.has(i.id)), ...(Array.isArray(saved) ? saved : [saved])]);
      return saved;
    } catch (err) {
      fail(prev, err, "Couldn't copy the items.");
      return null;
    }
  };

  const update = async (id, changes) => {
    if (String(id).startsWith("tmp-")) return toast.error("Still saving that item. Try again in a moment.");
    const prev = snapshot();
    setItems((old) => old.map((i) => (i.id === id ? { ...i, ...changes } : i)));
    try {
      const saved = await base44.entities.ProgramItem.update(id, changes);
      if (saved?.id) setItems((old) => old.map((i) => (i.id === id ? { ...i, ...saved } : i)));
      return saved;
    } catch (err) {
      fail(prev, err, "Couldn't save the change.");
      return null;
    }
  };

  const remove = async (id) => {
    if (String(id).startsWith("tmp-")) return;
    const prev = snapshot();
    setItems((old) => old.filter((i) => i.id !== id));
    try {
      await base44.entities.ProgramItem.delete(id);
      return true;
    } catch (err) {
      fail(prev, err, "Couldn't delete the item.");
      return false;
    }
  };

  const removeMany = async (ids) => {
    const prev = snapshot();
    const set = new Set(ids);
    setItems((old) => old.filter((i) => !set.has(i.id)));
    try {
      await Promise.all(ids.map((id) => base44.entities.ProgramItem.delete(id)));
      return true;
    } catch (err) {
      fail(prev, err, "Couldn't delete some items.");
      queryClient.invalidateQueries({ queryKey: key });
      return false;
    }
  };

  return { items: query.data || [], isLoading: query.isLoading, create, createMany, update, remove, removeMany };
}
