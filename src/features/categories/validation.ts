import { z } from "zod";

import {
  dictionaryStatusSchema,
  idSchema,
  nameSchema,
} from "@/features/master-data/shared";

export const createCategorySchema = z.object({ name: nameSchema });

export const updateCategorySchema = z.object({
  id: idSchema,
  name: nameSchema,
});

export const setCategoryStatusSchema = z.object({
  id: idSchema,
  status: dictionaryStatusSchema,
});
