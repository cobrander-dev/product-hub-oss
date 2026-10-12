import { z } from "zod";

import {
  dictionaryStatusSchema,
  idSchema,
  nameSchema,
} from "@/features/master-data/shared";

export const createMaterialSchema = z.object({ name: nameSchema });

export const updateMaterialSchema = z.object({
  id: idSchema,
  name: nameSchema,
});

export const setMaterialStatusSchema = z.object({
  id: idSchema,
  status: dictionaryStatusSchema,
});
